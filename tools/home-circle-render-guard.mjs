// Every browser-level check of the Home circle must call this FIRST.
// Headless Chromium on this box gets SwiftShader, and the circle deliberately
// switches itself off against /swiftshader|llvmpipe|softpipe|software|basic
// render/i rather than burn CPU on software WebGL. A check that samples a
// circle which never drew a frame goes green while measuring nothing.
export async function assertRendering(page, where = 'check') {
  const s = await page.evaluate(() => {
    const ring = document.querySelector('.home-circle')
    if (!ring) return { fatal: 'no .home-circle in the DOM' }
    if (!ring.homeCircleFluid) return { fatal: 'no homeCircleFluid diagnostics on the ring' }
    const st = ring.homeCircleFluid.stats()
    const canvasEl = ring.querySelector('.home-circle-fluid')
    return { state: st.state, reason: st.reason, webgl: st.webgl, canvas: st.canvas, raf: st.raf, steps: st.steps,
      live: !!canvasEl && canvasEl.classList.contains('is-live'),
      opacity: canvasEl ? Number(getComputedStyle(canvasEl).opacity) : 0 }
  })
  if (s.fatal) throw new Error(`${where}: DID NOT RENDER -- ${s.fatal}`)
  if (s.state !== 'running' || !s.canvas || !s.raf) {
    throw new Error(`${where}: DID NOT RENDER -- state=${s.state} reason=${s.reason || 'none'} `
      + `webgl=${s.webgl} canvas=${JSON.stringify(s.canvas)} raf=${s.raf} steps=${s.steps}. `
      + `Software WebGL (SwiftShader) switches the circle off; run headed or on a real GPU.`)
  }
  return s
}

/* WHAT A PERSON ACTUALLY SEES, AND WHY assertRendering IS NOT ENOUGH ON ITS OWN.
   assertRendering asks the renderer about itself, and every answer can be
   perfect while the circle is empty on screen. Measured, not argued: with the
   canvas held at the opacity the stylesheet gives it before reveal() is ever
   called -- `.home-circle-fluid { opacity: 0 }` until `.is-live` lands --
   assertRendering returns state=running, and 0.00% of the face differs from
   its own background. The WebGL buffer is full of a perfectly good body. The
   person sees a ring and nothing in it. That is the state the owner reported
   twice, and every instrument in this lane called it healthy.

   So this reads the COMPOSITED page instead: a screenshot of the circle
   element, which has CSS opacity, transforms, stacking and the theme
   background already applied, decoded in the page itself so it needs no image
   dependency. Everything inside the face is compared against the ring of
   background just inside the frame, so it measures ink against the actual
   backdrop rather than against an assumed colour, and works on every theme.

   Call it wherever a check claims the circle looks like anything at all. */
export async function assertVisibleInk(page, where = 'check', options = {}) {
  /* PROMPT B -- THE FLOORS, MEASURED ACROSS EVERY STATE THIS CIRCLE HAS, not guessed from
     one of them:
                          face differing    strongest difference
       empty (no reveal)       0.00%                 0/255
       thinking mist          42.90%                24/255
       resting body            5.8 - 8.3%          120/255
     Note the two real states sit at OPPOSITE corners -- the mist is wide and
     faint, the body is compact and strong -- so a floor calibrated on one of
     them alone rejects the other. minContrast was 25, taken from the body, and
     it failed the thinking cloud at 24. Both floors are now set against the
     empty case, which is the only thing this guard exists to catch, and which
     scores zero on both. */
  const { minFraction = 0.004, minContrast = 12, selector = '.home-circle' } = options // PROMPT B
  const guard = await assertRendering(page, where)
  const shot = await page.locator(selector).screenshot()
  const seen = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
    const flat = surface.getContext('2d')
    flat.drawImage(bitmap, 0, 0)
    const { data, width, height } = flat.getImageData(0, 0, bitmap.width, bitmap.height)
    // The face only. The frame and its status lip are not the body.
    const cx = width / 2, cy = height / 2, radius = Math.min(cx, cy) * 0.82
    let inside = 0, edgeCount = 0
    const backdrop = [0, 0, 0]
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const away = Math.hypot(x - cx, y - cy)
        if (away > radius) continue
        inside++
        if (away > radius * 0.93) {
          const i = (y * width + x) * 4
          backdrop[0] += data[i]; backdrop[1] += data[i + 1]; backdrop[2] += data[i + 2]
          edgeCount++
        }
      }
    }
    if (!edgeCount) return { fraction: 0, contrast: 0, inside }
    const base = backdrop.map(total => total / edgeCount)
    let differing = 0, contrast = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.hypot(x - cx, y - cy) > radius) continue
        const i = (y * width + x) * 4
        const diff = (Math.abs(data[i] - base[0]) + Math.abs(data[i + 1] - base[1]) + Math.abs(data[i + 2] - base[2])) / 3
        if (diff > 12) differing++
        if (diff > contrast) contrast = diff
      }
    }
    return { fraction: differing / inside, contrast, inside }
  }, shot.toString('base64'))

  if (seen.fraction < minFraction || seen.contrast < minContrast) {
    throw new Error(`${where}: THE CIRCLE IS EMPTY ON SCREEN -- `
      + `${(seen.fraction * 100).toFixed(2)}% of the face differs from its backdrop `
      + `(need ${(minFraction * 100).toFixed(2)}%), strongest difference ${seen.contrast.toFixed(0)}/255 `
      + `(need ${minContrast}). The renderer reports state=${guard.state} steps=${guard.steps} `
      + `is-live=${guard.live} opacity=${guard.opacity}. `
      + `A body in the WebGL buffer that CSS never reveals looks exactly like this.`)
  }
  return { ...guard, seen }
}
