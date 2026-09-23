/* What the owner actually looks at, measured off the real framebuffer.
   Four questions, one per owner report:
     1 the tool form is not five spinning dots
     2 the body has a defined edge when it is not being whispy
     3 perceived density moves with the morph instead of switching
     4 the thinking swirl runs long before it resets
   Every sample goes through assertVisibleInk first (see
   tools/home-circle-render-guard.mjs). Two ways to measure nothing and call it
   green: headless Chromium on this box gets SwiftShader and the circle
   switches itself off against software WebGL; and a circle that is running
   perfectly can still be held at opacity 0 by the stylesheet, which is an
   empty ring on screen and a full WebGL buffer underneath. The guard reads the
   composited page, so neither passes.

   node tools/home-circle-form-qa.mjs [outputDir] [origin] */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { assertRendering, assertVisibleInk } from './home-circle-render-guard.mjs'

const output = path.resolve(process.argv[2] || 'home-circle-form-qa')
const origin = process.argv[3] || process.env.HOME_CIRCLE_ORIGIN || 'http://127.0.0.1:4623'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'this probe drives a local dev origin only')
await mkdir(output, { recursive: true })

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const context = await browser.newContext({ viewport: { width: 760, height: 760 } })
// Keep this review mounted while other lanes edit the shared hotload: HTTP
// still serves the real current modules, only Vite's reload socket is cut.
await context.routeWebSocket(url => url.host === new URL(origin).host && url.searchParams.has('token'), socket => socket.close())

await context.addInitScript(({ theme }) => {
  localStorage.setItem('mc.theme', theme)
  /* Read the real final framebuffer, and describe every piece of material in
     it: where it sits relative to the body, how big it is, and -- the part
     that separates a dot from an arc -- how elongated it is. A satellite is
     round (aspect about 1); a band lying on a circle is long in one direction
     and thin in the other. No spacing change can disguise that. */
  for (const kind of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const proto = window[kind]?.prototype
    if (!proto) continue
    const original = proto.drawArrays
    proto.drawArrays = function (...args) {
      const result = original.apply(this, args)
      if (!window.captureCircle || !this.canvas.classList.contains('home-circle-fluid') || this.getParameter(this.FRAMEBUFFER_BINDING)) return result
      const width = this.drawingBufferWidth, height = this.drawingBufferHeight
      const pixels = new Uint8Array(width * height * 4)
      this.readPixels(0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels)
      const alpha = new Float32Array(width * height)
      let peak = 0, mass = 0, cx = 0, cy = 0
      for (let i = 0; i < width * height; i++) {
        const a = pixels[i * 4 + 3] / 255
        alpha[i] = a
        if (a > peak) peak = a
        if (a > .03) { mass += a; cx += a * (i % width); cy += a * Math.floor(i / width) }
      }
      cx = mass ? cx / mass : width / 2
      cy = mass ? cy / mass : height / 2

      /* The edge, in body radii: how far the alpha takes to fall from 90% of
         its own peak to 10% of it, averaged over rays out of the centroid.
         PROMPT F -- THE PEAK IS A PERCENTILE, NOT A MAXIMUM, and that is a
         correction to the measurement rather than a loosening of the bound.
         The body's surface catch adds its own COVERAGE as well as its own
         light, so a ray that happens to cross the catch saw a maximum alpha
         of 1.0 where the body's own plateau is 0.7. Every threshold here is
         relative to that peak, so the 90% mark stopped being the edge of the
         plateau and became the edge of the catch: the measured resting band
         went 0.182 -> 0.268 -> 0.329 across runs of the same renderer,
         depending only on whether a ray crossed the highlight, and the 0.329
         run went red. The body's outline had not changed at all.
         A high percentile of the alphas ALONG the ray is the plateau for any
         body with a plateau, and ignores a catch a few pixels wide. It is the
         same number as the maximum for a body with no catch, and that was
         checked rather than assumed: run against the pre-PROMPT-F renderer,
         this reads 0.1458 where the maximum read 0.153 and 0.182 on two runs
         of those same bytes. It is inside that renderer's own run-to-run
         spread and on the tighter side of it, so the bound was not loosened
         to let the catch through. On the renderer with the catch it reads
         0.203, still well inside the 0.30 bound. */
      const widths = []
      for (let k = 0; k < 64; k++) {
        const angle = k * Math.PI * 2 / 64, ux = Math.cos(angle), uy = Math.sin(angle)
        const max = Math.min(width, height) / 2
        let high = -1, low = -1
        const ray = []
        for (let r = 0; r < max; r++) {
          const px = Math.round(cx + ux * r), py = Math.round(cy + uy * r)
          if (px < 0 || py < 0 || px >= width || py >= height) break
          ray.push(alpha[py * width + px])
        }
        const solid = ray.filter(v => v > .02).sort((a, b) => a - b)
        const rayPeak = solid.length ? solid[Math.min(solid.length - 1, Math.floor(solid.length * .9))] : 0
        if (rayPeak < .08) continue
        for (let r = 0; r < max; r++) {
          const px = Math.round(cx + ux * r), py = Math.round(cy + uy * r)
          if (px < 0 || py < 0 || px >= width || py >= height) break
          const a = alpha[py * width + px]
          if (a >= rayPeak * .9) high = r
          if (high >= 0 && a <= rayPeak * .1) { low = r; break }
        }
        if (high >= 0 && low > high) widths.push({ band: (low - high) / Math.max(1, low), outer: low })
      }
      widths.sort((a, b) => a.band - b.band)

      // Connected material above a solid threshold, with its principal axes.
      const cut = Math.max(.1, peak * .35)
      const label = new Int32Array(width * height).fill(-1)
      const queue = new Int32Array(width * height), pieces = []
      for (let start = 0; start < label.length; start++) {
        if (label[start] >= 0 || alpha[start] < cut) continue
        let head = 0, tail = 1
        queue[0] = start; label[start] = pieces.length
        let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
        while (head < tail) {
          const index = queue[head++], px = index % width, py = Math.floor(index / width)
          n++; sx += px; sy += py; sxx += px * px; syy += py * py; sxy += px * py
          for (const next of [px ? index - 1 : -1, px < width - 1 ? index + 1 : -1, index - width, index + width]) {
            if (next < 0 || next >= label.length || label[next] >= 0 || alpha[next] < cut) continue
            label[next] = pieces.length; queue[tail++] = next
          }
        }
        if (n < 12) continue
        const mx = sx / n, my = sy / n
        const vxx = sxx / n - mx * mx, vyy = syy / n - my * my, vxy = sxy / n - mx * my
        const half = (vxx + vyy) / 2, root = Math.sqrt(Math.max(0, ((vxx - vyy) / 2) ** 2 + vxy * vxy))
        const major = Math.sqrt(Math.max(1e-9, half + root)), minor = Math.sqrt(Math.max(1e-9, half - root))
        /* HOW FULL THE PIECE IS, and it is the measure that survives a long
           arc. A uniform ellipse with semi-axes A and B has sqrt-variances
           A/2 and B/2, so its area is 4 * pi * major * minor -- fill is about
           1 for anything solid and far less for anything hollow. A satellite
           is solid. An arc is not, at ANY length, which matters because a long
           arc wraps and its two principal axes come back towards equal: a
           half-ring measured aspect 1.53 here and would have passed an
           aspect-only test while being obviously not a dot on screen. */
        pieces.push({ area: n / (width * height), aspect: major / minor,
          fill: n / (4 * Math.PI * major * minor),
          radius: Math.hypot(mx - cx, my - cy) / (width / 2) })
      }
      pieces.sort((a, b) => b.area - a.area)

      /* PROMPT A / PROMPT F. Shading, measured in a way that tells the
         MATERIAL from its own SURFACE, and then a surface from a layer.
         This block used to ask a different question -- form or gloss -- and
         bound the brightest pixel of the whole body against the brightest
         colour the material HAS, on the reasoning that a shade can only
         multiply and so nothing can ever be brighter than the light stop.
         That reasoning was sound and the bound was right for a body with no
         surface. The owner's reference photograph is a gummy with a hard
         white catch lying across it, so a body that CAN never be brighter
         than its own material is now the wrong body: a reflection is by
         definition brighter than the thing it sits on, and the ban would have
         to be broken to build what was asked for.
         So the two are separated rather than the bound deleted. The light
         stop is the brightest colour the material has, so anything above it
         is not material -- only a reflection can be there. Every measurement
         of the BODY is then taken with those pixels removed, which means the
         relief tilt, the internal gradient and the no-lift bound all still
         say exactly what they always said, about the material, and cannot be
         satisfied or broken by the catch. The catch gets its own bounds:
         how much of the body it is allowed to COVER (its existence is no
         longer the question, its extent is), and whether it follows the body
         or the canvas -- which is the whole difference between a surface and
         the layer the owner has rejected four times. */
      const ceiling = window.circleCeiling || 1
      const lums = [], along = []
      let bx = 0, by = 0, bn = 0
      for (let i = 0; i < width * height; i++) {
        if (alpha[i] < .15) continue
        bn++; bx += i % width; by += Math.floor(i / width)
      }
      bx /= Math.max(1, bn); by /= Math.max(1, bn)
      /* The light in src/home-circle-fluid.js is normalize(vec3(-0.45, 0.65,
         0.62)). readPixels rows run bottom-up and so does the shader's y, so
         the lit direction in this buffer is the same (-0.45, +0.65). Project
         every body pixel onto it and the lit flank and the far flank fall out
         directly -- which is what directional shading IS, and it does not
         depend on how many fringe pixels happened to clear the alpha floor
         the way a percentile spread over the whole body does. */
      const LX = -0.45 / Math.hypot(0.45, 0.65), LY = 0.65 / Math.hypot(0.45, 0.65)
      const xs = [], ys = []
      for (let i = 0; i < width * height; i++) {
        const a = alpha[i]
        if (a < .15) continue
        lums.push((pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / (3 * 255 * a))
        along.push((i % width - bx) * LX + (Math.floor(i / width) - by) * LY)
        xs.push(i % width); ys.push(Math.floor(i / width))
      }
      /* The split, and the 1.04 in it is the SAME 1.04 the old bound used:
         the tolerance on "as bright as the material's own light stop". Above
         it is the catch, at or below it is material. */
      const isCatch = k => lums[k] > ceiling * 1.04
      const bodyKeys = [], catchKeys = []
      for (let k = 0; k < lums.length; k++) (isCatch(k) ? catchKeys : bodyKeys).push(k)
      const order = bodyKeys.slice().sort((i, j) => along[i] - along[j])
      const sorted = bodyKeys.map(k => lums[k]).sort((x, y) => x - y)
      const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null
      const maxLum = sorted.length ? sorted[sorted.length - 1] : null
      const quarter = Math.floor(order.length / 4)
      const meanOf = idx => idx.reduce((t, i) => t + lums[i], 0) / Math.max(1, idx.length)
      const far = meanOf(order.slice(0, quarter)), lit = meanOf(order.slice(-quarter))
      const shading = bodyKeys.length < 200 ? null : {
        maxLum, p10: at(.1), p50: at(.5), p90: at(.9),
        spread: at(.9) - at(.1),
        lit, far, tilt: (lit - far) / Math.max(1e-6, at(.5)),
        hot: bodyKeys.filter(k => lums[k] >= maxLum * .95).length / bodyKeys.length,
        body: bodyKeys.length,
      }
      /* WHERE THE CATCH IS, not just how big it is. A surface reflects from
         the body's own boundary, so its centroid sits at a roughly fixed
         offset from the BODY's centroid however far the body has travelled
         across the face. A layer is composited at the canvas, so its centroid
         sits at a fixed offset from the CANVAS CENTRE instead and holds still
         while the body moves. The blob's seat wanders by design, so one run
         of samples separates the two on its own. Distances are in body radii
         so the reading does not move with the canvas size. */
      let hx = 0, hy = 0
      for (const k of catchKeys) { hx += xs[k]; hy += ys[k] }
      const radius = Math.sqrt(Math.max(1, lums.length) / Math.PI)
      const surface = catchKeys.length < 12 ? { share: catchKeys.length / Math.max(1, lums.length), peak: null, fromBody: null, fromCanvas: null }
        : {
          share: catchKeys.length / lums.length,
          peak: Math.max(...catchKeys.map(k => lums[k])) / Math.max(1e-6, ceiling),
          fromBody: Math.hypot(hx / catchKeys.length - bx, hy / catchKeys.length - by) / radius,
          fromCanvas: Math.hypot(hx / catchKeys.length - width / 2, hy / catchKeys.length - height / 2) / radius,
          bodyFromCanvas: Math.hypot(bx - width / 2, by - height / 2) / radius,
        }

      window.circleInk = { peak, mass: mass / (width * height), pieces, shading, surface,
        edgeBand: widths.length ? widths[Math.floor(widths.length / 2)].band : null,
        rays: widths.length, size: [width, height] }
      window.captureCircle = false
      return result
    }
  }
}, { theme: process.env.HOME_FORM_THEME || 'white' })

const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.message))
const report = { origin, at: new Date().toISOString(), cases: {} }
let failure = null

/* assertVisibleInk, not assertRendering. Every number below describes how the
   circle LOOKS, and the renderer can report itself perfectly healthy while the
   face is empty -- see the guard for the measurement that established it. */
async function sample(where) {
  await assertVisibleInk(page, where)
  await page.evaluate(() => {
    /* PROMPT F: the probe is told the material's own ceiling before it reads
       the buffer, because the split between the body and its surface is not a
       property of the pixels alone -- it is "brighter than the brightest
       colour this material HAS", and only the renderer knows that colour. */
    const stops = window.formReview.ring.homeCircleFluid.stats().stops
    const light = stops && stops.light ? stops.light : [1, 1, 1]
    window.circleCeiling = (light[0] + light[1] + light[2]) / 3
    window.captureCircle = true
  })
  await page.waitForFunction(() => !window.captureCircle, null, { timeout: 5000 })
  return page.evaluate(() => ({ stats: window.formReview.ring.homeCircleFluid.stats(), ink: window.circleInk }))
}
async function setAction(action, tool = '') {
  await page.evaluate(([action, tool]) => {
    const ring = window.formReview.ring
    ring.dataset.agentAction = action
    if (tool) ring.dataset.agentTool = tool; else delete ring.dataset.agentTool
  }, [action, tool])
  await page.waitForFunction(action => window.formReview.ring.homeCircleFluid.stats().agent.action === action, action)
}

try {
  await page.goto(`${origin}/#/settings`, { waitUntil: 'load' })
  await page.getByRole('searchbox', { name: 'Search all settings' }).waitFor()
  await page.evaluate(async () => {
    const { homeCircleMarkup } = await import('/src/home-circle.js')
    const { mountHomeCircleFluid } = await import('/src/home-circle-fluid.js')
    const { mountHomeStatusColors } = await import('/src/home-status-colors.js')
    const fixture = document.createElement('section')
    fixture.className = 'home'
    fixture.dataset.ledgerStatus = 'clear'
    mountHomeStatusColors(fixture)
    fixture.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:var(--bg)'
    // No optional extras: the idle personality and the blowup episode would
    // move the body under the measurement for reasons unrelated to the form.
    fixture.innerHTML = `<div class="uring crescent home-circle" style="width:520px;height:520px" data-fluid="on" data-fluid-extras="" data-circle-style="standard" data-circle-motion="animate" data-load="busy" data-agent-action="idle" data-agent-key="form-review" data-agent-name="Form review" data-agent-event="0">${homeCircleMarkup()}</div>`
    document.body.appendChild(fixture)
    const ring = fixture.querySelector('.home-circle')
    const mounted = mountHomeCircleFluid(ring)
    window.formReview = { ring, destroy() { mounted.destroy(); fixture.remove() } }
  })
  await page.waitForFunction(() => window.formReview.ring.homeCircleFluid?.stats().steps > 40, null, { timeout: 20000 })

  /* ---------------------------------------------------- 1 the tool form */
  await setAction('running', 'Bash')
  await page.waitForTimeout(2500) // past `release`, so the bands are fully open
  const tool = []
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(220)
    tool.push(await sample('tool form'))
    if (i % 8 === 0) await page.screenshot({ path: path.join(output, `tool-${i}.png`) })
  }
  report.cases.tool = tool.map(({ stats, ink }) => ({ phase: stats.agent.motion.phase, pattern: stats.agent.motion.pattern,
    ring: stats.agent.ring, ringTurn: stats.agent.ringTurn, ringSpin: stats.agent.ringSpin, parts: stats.agent.parts,
    mass: stats.material.mass, peak: ink.peak, edgeBand: ink.edgeBand,
    pieces: ink.pieces.map(p => ({ area: +p.area.toFixed(5), aspect: +p.aspect.toFixed(2), fill: +p.fill.toFixed(2), radius: +p.radius.toFixed(3) })) }))

  const open = tool.filter(f => f.stats.agent.ringTurn[3] > .9)
  assert.ok(open.length > 20, `the bands open and stay open, got ${open.length} of ${tool.length} samples`)
  assert.ok(open.every(f => f.stats.agent.motion.pattern === 'chat-orbit'), 'the tool form is the chat orbit set')
  /* THE OWNER'S REPORT, AS A NUMBER. A satellite is round: its two principal
     axes are about equal. An arc lying on a circle is not, whatever radius it
     sits at, so re-spacing a ring of dots cannot pass this. ROUND is 1.6 --
     the old satellites measured about 1.0 and the breathing core of this form
     measures 1.0 to 1.4, while the loosest band arc measured here is 1.88. */
  const ROUND = 1.6, SOLID = .55, CENTRE = .25
  /* WHAT A SATELLITE IS, MEASURED: a piece that is compact AND solid. Either
     one alone lets something through -- a full ring is compact by second
     moments (it is circular), and a short straight streak is solid -- so both
     are required together.
     This does not try to identify the core and skip it, which is what two
     earlier versions did and both got wrong. Picking the largest piece broke
     when the track ring got bright enough to outweigh the core; picking the
     piece nearest the centroid broke because a RING's centroid is the centre,
     so it beat the core every time. The honest statement needs neither: five
     dots are five solid compact pieces, and this form has exactly one, the
     core, sitting at the middle. Measured on a passing run: the core is
     fill 1.00 at radius 0.07 to 0.09, the two rings are fill 0.04 to 0.08,
     and the loose arcs are aspect 5 to 14. CENTRE is 0.25 because the core's
     own distance from the overall ink centroid reaches 0.18 when the rings are
     lopsided -- measured -- while the satellites this is guarding against orbit
     at 0.33. A tighter bound fired on the core itself.
     Nothing is asserted about a HOLLOW piece's shape. A hollow piece is not a
     dot whatever its aspect, and a band that has not closed into a full ring
     is a long thin arc by construction -- an earlier version of this check
     demanded aspect < 3 of them and failed on a perfectly good 5.8. */
  for (const frame of open) {
    const real = frame.ink.pieces.filter(p => p.area > .0004)
    const solid = real.filter(p => p.aspect < ROUND && p.fill > SOLID)
    assert.ok(solid.length <= 1,
      `only the core may be a solid round piece, got ${solid.length}: ${JSON.stringify(solid)}`)
    for (const piece of solid) {
      assert.ok(piece.radius < CENTRE,
        `the one solid piece is the body's own centre, not something orbiting it: ${JSON.stringify(piece)}`)
    }
  }
  const dotty = open.filter(f => f.ink.pieces.filter(p => p.area > .0004)
    .filter(p => p.aspect < ROUND && p.fill > SOLID).length >= 4)
  assert.equal(dotty.length, 0, 'no frame is a ring of discrete dots')
  assert.ok(open.some(f => f.stats.agent.ring[0] > 0 && f.stats.agent.ring[1] > 0), 'two bands at two radii')
  assert.ok(open.some(f => f.stats.agent.ringSpin[0] > 0 && f.stats.agent.ringSpin[1] < 0),
    'the two bands turn against each other')
  // Centred on the body, never on the canvas: the whole set sits around the
  // seat, wherever the seat has drifted to.
  for (const frame of open) {
    const seat = frame.stats.seat
    assert.ok(Math.hypot(seat.x - .5, seat.y - .5) <= (seat.wallRadius ?? .36) + .001)
  }

  /* ---------------------------------------- 2 and 3 the edge and the weight */
  await setAction('idle')
  await page.waitForTimeout(4000)
  const rest = []
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400)
    rest.push(await sample('resting body'))
    if (i % 10 === 0) await page.screenshot({ path: path.join(output, `rest-${i}.png`) })
  }
  report.cases.rest = rest.map(({ stats, ink }) => ({ joined: stats.agent.character[0], mass: stats.material.mass,
    wisp: stats.material.wisp, peak: ink.peak, edgeBand: ink.edgeBand, rays: ink.rays, shading: ink.shading }))

  /* PROMPT A: the resting body is shaded, and the shading is form, not gloss.
     Both halves are asserted here so neither can be "fixed" by losing the
     other -- deleting the relief fails the first, and re-adding a specular
     fails the second. */
  const shaded = rest.map(f => f.ink.shading).filter(Boolean)
  assert.ok(shaded.length > 20, `the resting body was bright enough to measure on ${shaded.length} of ${rest.length} samples`)
  const mean = key => shaded.reduce((a, s) => a + s[key], 0) / shaded.length
  // Relative to the material's own brightness, so the measure does not move
  // with the palette or the theme.
  const relief = mean('tilt')
  // How far the brightest pixel sits above the top decile, in units of the
  // gradient's own range. A smooth directional shade ends its gradient there;
  // a specular sits well above it.
  const spike = (mean('maxLum') - mean('p90')) / mean('spread')
  report.restShading = { relief, spike, spread: mean('spread'), p50: mean('p50'), hot: mean('hot'),
    lit: mean('lit'), far: mean('far'), maxLum: Math.max(...shaded.map(s => s.maxLum)) }
  /* THRESHOLDS MEASURED, NOT GUESSED, AND RE-MEASURED WHEN THE RENDERER
     CHANGED UNDER THEM. The original table was taken when the shade was a
     multiplier with a fixed 0.72..1.0 range:
                              tilt      spike   maxLum/p50
       no shading (relief 0)  -0.010     1.47      1.15
       directional relief     +0.045..   2.45      1.21
                              +0.082
       uSheen specular added  +0.089    20.40      4.07
     and the tilt floor was set at 0.025, inside that gap. The shading is now
     optical depth inside the absorption exponent and is far stronger, so the
     gap moved and the old floor stopped covering it. Measured on this probe,
     same fixture, 30 resting samples each:
                              tilt     spike   catch share
       relief off (0)          0.033    1.80     2.63%
       shipped                 0.252    2.43     2.55%
     0.033 is not zero because the second dye and the catch's own shoulder
     leave a small directional reading behind; it PASSED the 0.025 floor, so
     the floor was measuring nothing. It is 0.09 now: 2.7x above the relief-off
     reading and 2.8x below the shipped one, which is the middle of the gap
     that actually exists. Turning the relief off is red again.
     Note the tilt column alone still cannot tell form from a gloss LAYER --
     the old sheen scored higher on it than the relief did. That is the
     distinction this lane kept losing, so the catch is measured separately
     for its extent and for whether it follows the body or the canvas. */
  /* THE BOUND THE MATERIAL STILL MAKES, now that it has a surface over it.
     The material is absorption and shading only: every factor is <= 1 out of
     the light stop, so no pixel OF THE MATERIAL can be brighter than it. That
     claim is unchanged and is asserted unchanged -- it is just taken over the
     body with the catch's own pixels removed, which is where it was always
     really about. The catch is above the ceiling by construction; that is the
     definition used to find it.
     What is gone is the claim that NO pixel anywhere can be above the light
     stop. The owner's reference is a photographed gummy with a hard white
     highlight across it, and that bound forbids exactly that. Deleting it
     outright would have thrown away the protection it was built for, so it is
     replaced below by a bound on the catch's EXTENT -- which is the property
     that separates a reflection from a wash, and which a flat fill fails on
     its own terms, because every pixel of a flat body is within 5% of its own
     brightest and the share goes to 1. */
  const stops = rest.map(f => f.stats.agent?.stops || f.stats.stops).filter(Boolean)
  assert.ok(stops.length > 20, 'the renderer reported the colour stops it is mixing between')
  const lum = c => (c[0] + c[1] + c[2]) / 3
  const ceiling = Math.max(...stops.map(s => lum(s.light)))
  const lift = mean('maxLum') / Math.max(1e-6, ceiling)
  report.restShading.lift = lift
  report.restShading.ceiling = ceiling
  assert.ok(relief > .09, `the flank facing the light is brighter than the flank facing away, by ${(relief * 100).toFixed(1)}% of the body's own brightness`)
  assert.ok(spike < 8, `with the catch removed, the brightest part of the material is the end of a gradient rather than a highlight sitting on top of one: ${spike.toFixed(2)}`)
  /* AND THE ONE THAT HAD TO CHANGE SHAPE, not just scope. The old assertion
     was max(body) / ceiling <= 1.04. Once the catch is DEFINED as everything
     above ceiling * 1.04, the material's maximum is bounded by that threshold
     by construction and the assertion can no longer fail -- it measured 1.029
     against a 1.04 bound and would measure the same against any renderer at
     all. A gate that cannot go red is worse than no gate, because the report
     says it passed.
     So `lift` is still reported, as the derived number it now is, and the
     claim it used to carry is asserted where it can still fail: nine tenths
     of the material sits below the material's own light stop. A wash over the
     body lifts the bulk of it, not only its brightest pixel, so it fails
     here; a catch leaves the bulk exactly where it was. */
  assert.ok(mean('p90') < ceiling,
    `nine tenths of the material sits below its own light stop, ${mean('p90').toFixed(3)} against ${ceiling.toFixed(3)} (lift, now bounded by the split itself and reported rather than asserted: ${lift.toFixed(3)})`)
  /* The body must have an internal gradient at all. A flat fill passes a tilt
     test on noise alone, and it was the costliest defect this lane found, so
     it is asserted directly rather than left to be implied by the tilt. */
  assert.ok(mean('spread') > .03, `the material carries an internal gradient rather than one flat value, p90 - p10 = ${mean('spread').toFixed(4)} of its own brightness`)

  /* ------------------------------------ 3b the surface, and surface vs layer */
  const surfaces = rest.map(f => f.ink.surface).filter(Boolean)
  assert.ok(surfaces.length > 20, `the surface was measurable on ${surfaces.length} of ${rest.length} samples`)
  const meanSurface = key => surfaces.filter(s => s[key] != null).reduce((a, s) => a + s[key], 0)
    / Math.max(1, surfaces.filter(s => s[key] != null).length)
  const share = meanSurface('share')
  const placed = surfaces.filter(s => s.fromBody != null)
  report.restSurface = { share, peak: meanSurface('peak'), placed: placed.length,
    fromBody: meanSurface('fromBody'), fromCanvas: meanSurface('fromCanvas'), bodyFromCanvas: meanSurface('bodyFromCanvas') }
  /* MEASURED OFF THE OWNER'S OWN REFERENCE, not guessed: on that photograph
     0.89% of the cube sits within 5% of its brightest pixel and 4.13% within
     10%, against a body at saturation 0.83 and a catch at 0.13. So a catch is
     a low-single-digit percentage of the body. A wash is tens of percent and a
     flat fill is 100%, because every pixel of a flat body is its own peak. */
  assert.ok(share < .12, `the catch is a reflection on the body, not a wash over it: it covers ${(share * 100).toFixed(2)}% of the body (the owner's reference photograph: 0.89% within 5% of its peak, 4.13% within 10%)`)
  assert.ok(share > 0, 'the body has a surface catch at all')
  /* SURFACE OR LAYER, and this is the assertion the owner's four rejections
     are actually about. A catch computed from the body's own geometry sits at
     a roughly fixed offset from the BODY however far the body has travelled;
     a layer composited over the circle sits still against the CANVAS. The
     seat wanders by design, so the two are separable in one run -- and the
     comparison is made against how far the body itself moved, so it cannot
     pass on a body that happened to stay put. */
  assert.ok(placed.length > 20, `the catch was placed on ${placed.length} of ${rest.length} samples`)
  const travelled = report.restSurface.bodyFromCanvas
  assert.ok(report.restSurface.fromBody < report.restSurface.fromCanvas,
    `the catch follows the body, not the canvas: ${report.restSurface.fromBody.toFixed(2)} body radii from the body and ${report.restSurface.fromCanvas.toFixed(2)} from the canvas centre, with the body itself ${travelled.toFixed(2)} from it`)
  const restEdges = rest.map(f => f.ink.edgeBand).filter(v => v != null)
  assert.ok(restEdges.length > 20, `the resting body was measurable on ${restEdges.length} of ${rest.length} samples`)
  const restEdge = restEdges.reduce((a, b) => a + b, 0) / restEdges.length
  report.restEdge = restEdge

  await setAction('thinking')
  const think = []
  /* The swirl runs thirty seconds, and the ten-second action rest
     (updateActionRest in src/home-circle-motion.js) can land on top of it and
     restart the count -- measured here, a rest at 28 s elapsed cut a swirl
     half a second before its own reset. The window therefore has to clear a
     full cycle PLUS a whole rest, not just a cycle. */
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(400)
    think.push(await sample('thinking'))
    if (i % 12 === 0) await page.screenshot({ path: path.join(output, `think-${i}.png`) })
  }
  report.cases.think = think.map(({ stats, ink }) => ({ phase: stats.agent.motion.phase, elapsed: stats.agent.elapsed,
    original: stats.flow.original, storm: stats.storm, mass: stats.material.mass, wisp: stats.material.wisp,
    peak: ink.peak, edgeBand: ink.edgeBand }))
  const thinkEdges = think.map(f => f.ink.edgeBand).filter(v => v != null)
  const thinkEdge = Math.max(...thinkEdges)
  report.thinkEdge = thinkEdge
  assert.ok(restEdge < .3, `at rest the body ends over a narrow band of its own radius, got ${restEdge.toFixed(3)}`)
  assert.ok(thinkEdge > restEdge * 1.5, `the whispy form is visibly softer than the resting one, ${thinkEdge.toFixed(3)} vs ${restEdge.toFixed(3)}`)

  // Continuous, not two presets: the weight visits the middle of its range
  // and never jumps across it between samples.
  const masses = think.map(f => f.stats.material.mass)
  const middle = masses.filter(m => m > .2 && m < .8)
  assert.ok(middle.length > 8, `density passes through the middle of its range, got ${middle.length} samples`)
  let worst = 0
  for (let i = 1; i < masses.length; i++) worst = Math.max(worst, Math.abs(masses[i] - masses[i - 1]))
  report.worstMassStep = worst
  assert.ok(worst < .45, `density never steps across its range between samples, worst ${worst.toFixed(3)} over 400ms`)

  /* ------------------------------------------------ 4 the thinking swirl */
  const marks = think.map(f => ({ phase: f.stats.agent.motion.phase, elapsed: f.stats.agent.elapsed }))
  const pauses = marks.filter(m => m.phase === 'pause')
  assert.ok(pauses.length > 0,
    'the swirl resets and holds within the sample window; if this is the only failure, the ten-second action rest pre-empted every cycle and nothing about the reset was measured')
  const firstPause = Math.min(...pauses.map(m => m.elapsed))
  report.firstPauseAt = firstPause
  assert.ok(firstPause > 25, `the swirl runs far past its old ten and eighteen seconds before resetting, first hold at ${firstPause.toFixed(1)}s`)
  const held = pauses.length * .4
  assert.ok(held < 4, `the hold stays a punctuation mark, measured about ${held.toFixed(1)}s of holds in the window`)
  assert.ok(marks.slice(marks.indexOf(marks.find(m => m.phase === 'pause'))).some(m => m.phase === 'swirl'), 'and it loops')

  /* AND IT PULSES WHILE IT SWIRLS. The owner's steer was "it can get really
     slow... then pulse again", so the cloud has to visibly gather and push out
     more than once inside a single swirl. Measured off the rendered mass, not
     off the motion object, so a beat that never reaches the water fails. */
  const swirling = think.filter(f => f.stats.agent.motion.phase === 'swirl' && f.stats.flow.original > .9)
  const inked = swirling.map(f => f.ink.mass)
  const turns = swirling.map(f => f.stats.flow.torque)
  report.thinkPulse = { samples: inked.length, inkLow: Math.min(...inked), inkHigh: Math.max(...inked),
    torqueLow: Math.min(...turns), torqueHigh: Math.max(...turns) }
  assert.ok(inked.length > 40, `the swirl was sampled ${inked.length} times`)
  assert.ok(Math.max(...inked) > Math.min(...inked) * 1.4,
    `the cloud swells and settles as it pulses: ${Math.min(...inked).toFixed(4)} to ${Math.max(...inked).toFixed(4)}`)
  let crossings = 0
  const mid = (Math.max(...inked) + Math.min(...inked)) / 2
  for (let i = 1; i < inked.length; i++) if ((inked[i - 1] < mid) !== (inked[i] < mid)) crossings++
  report.thinkPulse.crossings = crossings
  assert.ok(crossings >= 4, `it pulses again rather than swelling once, ${crossings} crossings of its own midpoint`)
} catch (error) {
  failure = error
} finally {
  report.pageErrors = errors
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
assert.deepEqual(errors, [], 'the page raised no errors')
if (failure) throw failure
console.log(`home circle form QA: ok -- rest edge ${report.restEdge?.toFixed(3)}, whispy edge ${report.thinkEdge?.toFixed(3)}, first hold at ${report.firstPauseAt?.toFixed(1)}s`)
