/* Shared plumbing for the home-circle browser gates (material and motion).
 *
 * Everything here is about getting an HONEST picture of the body out of the
 * live app: a browser that really draws WebGL, a renderer that is really
 * running, a crop that contains the body and nothing else, and a ground the
 * body is really composited over. None of it reads src/.
 *
 * Linux and Windows both (R1226): the browser is chosen by trying, in order,
 * the caller's HOME_CIRCLE_CHANNEL, then the branded channels this box may
 * have, then Playwright's bundled Chromium with software-GL flags; the first
 * one whose page reports the circle RUNNING wins and its name goes in the
 * receipt. Headless bundled Chromium on this box gets SwiftShader and the
 * circle switches itself off against it (tools/home-circle-render-guard.mjs),
 * which is why the branded channels are tried first.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assertRendering } from '../home-circle-render-guard.mjs'

const require = createRequire(import.meta.url)
export const { chromium } = require(process.env.MC_PLAYWRIGHT_ROOT || 'playwright')

export const ORIGIN = process.env.HOME_CIRCLE_ORIGIN || 'http://127.0.0.1:4623'

export function fingerprint (repo, file) {
  try {
    const bytes = fs.readFileSync(path.join(repo, file))
    const stat = fs.statSync(path.join(repo, file))
    return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mtime: stat.mtime.toISOString() }
  } catch { return { file, sha256: null } }
}

const CANDIDATES = () => [
  ...(process.env.HOME_CIRCLE_CHANNEL ? [{ channel: process.env.HOME_CIRCLE_CHANNEL, args: [] }] : []),
  { channel: 'msedge', args: [] },
  { channel: 'chrome', args: [] },
  { channel: null, args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  { channel: null, args: [] }
]

/* Open a browser + page with the Home view on `theme`, rich scheme, motion on,
   and the renderer confirmed RUNNING. Tries each candidate browser in turn.
   `init` runs before any page script (addInitScript) so a seed can be planted
   where the renderer reads it at attach. */
export async function openHome ({ theme = 'black', viewport = { width: 1280, height: 900 }, dpr = 2, init = null, where = 'open', log = () => {} } = {}) {
  const failures = []
  for (const cand of CANDIDATES()) {
    let browser = null
    try {
      browser = await chromium.launch({ headless: true, ...(cand.channel ? { channel: cand.channel } : {}), args: cand.args })
    } catch (error) { failures.push(`${cand.channel || 'chromium'}: ${error.message.split('\n')[0]}`); continue }
    try {
      const page = await openPage(browser, { theme, viewport, dpr, init, where })
      log(`browser ${cand.channel || 'chromium'}${cand.args.length ? ' ' + cand.args.join(' ') : ''}`)
      return { browser, page, channel: cand.channel || `chromium${cand.args.length ? ' ' + cand.args.join(' ') : ''}` }
    } catch (error) {
      failures.push(`${cand.channel || 'chromium'}: ${error.message.split('\n')[0]}`)
      await browser.close().catch(() => {})
    }
  }
  const error = new Error(`${where}: no browser on this machine draws the circle -- ${failures.join(' | ')}`)
  error.refusal = true
  throw error
}

export async function openPage (browser, { theme = 'black', viewport = { width: 1280, height: 900 }, dpr = 2, init = null, where = 'open' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr })
  await ctx.routeWebSocket(u => u.host === new URL(ORIGIN).host && u.searchParams.has('token'), s => s.close())
  await ctx.addInitScript((t) => {
    localStorage.setItem('mc.theme', t)
    localStorage.removeItem('mc.set.home_circle_style')
    localStorage.setItem('mc.set.home_circle_motion', 'animate')
  }, theme)
  if (typeof init === 'string') await ctx.addInitScript(init)
  else if (init) await ctx.addInitScript(init.fn, init.arg)
  const page = await ctx.newPage()
  page.outsideRequests = 0
  await installMutations(page)
  /* OUTSIDE means off this machine. The app probes sibling loopback ports for
     local engines (127.0.0.1:4610-4612/v1/runtime, refused by CORS) on every
     load; those are not egress and a receipt that counted them (measured: 40
     on one presence run) would fail the cut for a request that never left
     the box. */
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  page.on('request', r => { try { const u = new URL(r.url()); if (!LOOPBACK.has(u.hostname) && u.protocol !== 'data:' && u.protocol !== 'blob:') page.outsideRequests++ } catch { /* not a URL */ } })
  page.pageErrors = []
  page.on('pageerror', e => page.pageErrors.push(String(e && e.message || e).slice(0, 200)))
  await page.goto(`${ORIGIN}/#/`, { waitUntil: 'load', timeout: 120000 })
  /* THREE causes photograph the same empty circle and a gate must name which
     one it hit rather than score the blank (Manager, 2026-09-18):
       DEAD BUNDLE   a syntax error in a served module: no .home-circle at all,
                     and the page reports the SyntaxError;
       SOFTWARE GL   headless Chromium gets SwiftShader and the fluid refuses
                     it: data-fluid-reason="software-webgl";
       DEAD SHADER   the program never compiled: state fails with a GL note.
     Each is thrown as a refusal with its own name; none of them is a verdict. */
  try {
    await page.waitForSelector('.home-circle', { timeout: 30000 })
  } catch {
    const err = new Error(`${where}: DEAD BUNDLE -- no .home-circle in the document after 30 s; page errors: ${page.pageErrors.join(' | ') || 'none'}`)
    err.refusal = 'dead-bundle'; throw err
  }
  await page.bringToFront()
  try { await waitRunning(page, where) } catch (error) {
    const diag = await page.evaluate(() => { const r = document.querySelector('.home-circle'); const s = r && r.homeCircleFluid ? r.homeCircleFluid.stats() : null; return s ? { state: s.state, reason: s.reason, note: s.note, webgl: s.webgl, canvas: s.canvas } : null })
    const cause = diag && /software/.test(diag.reason || '') ? 'SOFTWARE WEBGL' : diag && diag.note ? 'DEAD SHADER' : 'NOT RUNNING'
    const err = new Error(`${where}: ${cause} -- ${JSON.stringify(diag)}; page errors: ${page.pageErrors.join(' | ') || 'none'}`)
    err.refusal = cause.toLowerCase().replace(' ', '-'); throw err
  }
  await assertRendering(page, where)
  /* The crop must be the BODY. The ring's own children are the SVG rim and the
     centre readout; div.first-use-layer is the onboarding card, position:fixed
     at z-index 65 and NOT a child of the ring, so a rule scoped to the ring
     leaves it painting a white button over the crop. */
  await page.addStyleTag({ content: '.home-circle > *:not(.home-circle-fluid){visibility:hidden !important}.first-use-layer{display:none !important}' })
  page.gateContext = ctx
  return page
}

/* MUTATION CHECKS WITHOUT TOUCHING THE TREE. A gate nobody has seen fail is
   not a gate, and this lane may not write src/. So a mutation is applied to
   the module text IN FLIGHT: HOME_CIRCLE_MUTATIONS names a JSON file of
   [{file, find, replace, why}], and every served copy of that module has the
   substitution made on its way to the page. The source on disk is untouched,
   the dev server is untouched, other lanes see nothing. A `find` that matches
   nothing throws, because a mutation that did not apply would make a red look
   like a green. Runs under mutation are marked in `page.mutations` so the
   receipt says so. */
export async function installMutations (page) {
  const file = process.env.HOME_CIRCLE_MUTATIONS
  if (!file) { page.mutations = null; return }
  const list = JSON.parse(fs.readFileSync(file, 'utf8'))
  page.mutations = list.map(m => ({ ...m, applied: 0 }))
  await page.route(u => /\/src\/[^?]+\.js(\?|$)/.test(u.pathname + u.search), async route => {
    const url = new URL(route.request().url())
    const hits = page.mutations.filter(m => url.pathname === '/' + m.file)
    if (!hits.length) return route.continue()
    const response = await route.fetch()
    let body = await response.text()
    for (const m of hits) {
      if (!body.includes(m.find)) { await route.abort(); throw new Error(`mutation did not apply: ${m.file} has no "${m.find.slice(0, 60)}"`) }
      body = body.split(m.find).join(m.replace)
      m.applied++
    }
    return route.fulfill({ response, body, headers: { ...response.headers(), 'content-length': String(Buffer.byteLength(body)) } })
  })
}

/* The solver's run condition includes document.hasFocus(), so the circle
   pauses without focus and a capture taken then is a frozen buffer. Wait for
   it to say running rather than sleeping and hoping. */
export async function waitRunning (page, where, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const r = document.querySelector('.home-circle')
      if (!r || !r.homeCircleFluid) return null
      const s = r.homeCircleFluid.stats()
      return { state: s.state, reason: s.reason, steps: s.steps, focus: document.hasFocus() }
    })
    if (last && last.state === 'running' && last.steps > 0) return last
    await page.bringToFront()
    await page.waitForTimeout(400)
  }
  throw new Error(`${where}: renderer never reached running -- last=${JSON.stringify(last)}`)
}

/* The ground the body composites over. src/home-circle.css paints an opaque
   disc on the ring's ::before at exactly the canvas footprint, BETWEEN any
   background on .home-circle and the body, and a pseudo element is not matched
   by "> *", so the ground has to go there or it measures nothing. */
export async function setGround (page, rgb) {
  await page.evaluate((c) => {
    let tag = document.getElementById('jelly-gate-ground')
    if (!tag) { tag = document.createElement('style'); tag.id = 'jelly-gate-ground'; document.head.appendChild(tag) }
    tag.textContent = `.home .home-circle[data-circle-style="standard"]::before{background:${c} !important}.home-circle{background:${c} !important}`
  }, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`)
}

export const formOf = page => page.evaluate(() => {
  const r = document.querySelector('.home-circle')
  const s = r && r.homeCircleFluid ? r.homeCircleFluid.stats() : null
  return s && s.agent && s.agent.motion ? s.agent.motion.form : (s ? 0 : null)
})

/* The Home view repaints data-agent-action from the example fleet, so setting
   the attribute is a request and not a state. Confirm the renderer is on the
   wanted form or throw, rather than attributing a number to a state the body
   was never in. form 0 means "no motion object", which is what idle reports
   when the action carries no form of its own. */
export async function holdForm (page, { action, tool = '', form, tries = 40 }) {
  let got = null
  for (let i = 0; i < tries; i++) {
    await page.evaluate((x) => {
      const r = document.querySelector('.home-circle')
      if (r) { r.dataset.agentAction = x.action; r.dataset.agentTool = x.tool }
    }, { action, tool })
    got = await formOf(page)
    if (got === form) return got
    await page.waitForTimeout(250)
  }
  throw new Error(`holdForm(${action}): renderer stayed on form ${got}, wanted ${form}`)
}

/* Screenshot the canvas element and decode it IN THE PAGE to raw RGBA, so the
   driver needs no image dependency and runs the same on Linux and Windows. */
export async function grabCanvas (page, where) {
  await waitRunning(page, where)
  await assertRendering(page, where)
  const shot = await page.locator('.home-circle-fluid').first().screenshot()
  const out = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
    const flat = surface.getContext('2d')
    flat.drawImage(bitmap, 0, 0)
    const img = flat.getImageData(0, 0, bitmap.width, bitmap.height)
    let s = ''
    const d = img.data
    for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, Math.min(i + 8192, d.length)))
    return { width: img.width, height: img.height, b64: btoa(s) }
  }, shot.toString('base64'))
  return { width: out.width, height: out.height, data: Buffer.from(out.b64, 'base64'), png: shot }
}

/* A capture that does NOT focus the page: no waitRunning, no bringToFront,
   no assertRendering -- the composited element as it is. For the presence
   proof's never-focused case, where raising the window would be the thing
   under test. The caller judges the pixels. */
export async function grabCanvasUnfocused (page) {
  const shot = await page.locator('.home-circle-fluid').first().screenshot()
  const out = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
    const flat = surface.getContext('2d')
    flat.drawImage(bitmap, 0, 0)
    const img = flat.getImageData(0, 0, bitmap.width, bitmap.height)
    let s = ''
    const d = img.data
    for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, Math.min(i + 8192, d.length)))
    return { width: img.width, height: img.height, b64: btoa(s) }
  }, shot.toString('base64'))
  return { width: out.width, height: out.height, data: Buffer.from(out.b64, 'base64'), png: shot }
}

/* ---------------------------------------------- pin before boot (init) */

export /* PIN THE FLEET'S FIVE ATTRIBUTES FROM THE MOMENT THE RING EXISTS, before
   boot() steps its first 1.5 s: pinned afterwards, the run has already
   diverged on whatever action/key/name/event the example fleet painted first
   (body lane, det.mjs: 90 of 90 draws identical only when pinned before boot). */
const PIN_INIT = (state) => {
  /* Observed on `document`, not documentElement: an init script runs before
     the document has an element, and observe(null) throws -- measured as the
     fleet's own action/key/event winning on every seeded run. */
  const want = { agentAction: state.action, agentTool: state.tool || '', agentKey: state.key, agentName: state.name, agentEvent: state.event }
  const pin = ring => { for (const k in want) if (ring.dataset[k] !== want[k]) ring.dataset[k] = want[k] }
  const seen = new WeakSet()
  const look = () => { const ring = document.querySelector('.home-circle'); if (!ring) return; pin(ring); if (!seen.has(ring)) { seen.add(ring); new MutationObserver(() => pin(ring)).observe(ring, { attributes: true, attributeFilter: ['data-agent-action', 'data-agent-tool', 'data-agent-key', 'data-agent-name', 'data-agent-event'] }) } }
  new MutationObserver(look).observe(document, { childList: true, subtree: true })
  look()
}

/* -------------------------------------------------- per-frame sampler */

/* Sample the canvas at EVERY DISPLAY DRAW, from the framebuffer, in the page.
 *
 * WHY THIS SHAPE, twice measured. Element screenshots cost 50-100 ms each and
 * cannot see a 4-6 Hz bounce. The first sampler chained onto the renderer's
 * requestAnimationFrame callback and copied the canvas with drawImage(); it
 * read peak ink 0 at step 90 and step 240 on builds where the body lane's
 * framebuffer readback (.lane-scratch/w11/firstink.mjs) found 5316 opaque
 * pixels in draw 1 -- so it was reading the wrong surface, or reading it at
 * a moment the buffer was not there to copy. This one does what the body
 * lane's instrument does: it wraps drawArrays on the WebGL prototypes and,
 * for the fluid canvas's draws to the DEFAULT framebuffer (the display pass,
 * not the solver's offscreen passes), reads the pixels back right there, with
 * the renderer's step count attached. The framebuffer is premultiplied, so
 * RGB is already the body composited over black, which is the ground every
 * pixel measure here uses. Rows are flipped (readPixels is bottom-up) and
 * the frame is box-sampled to `size`.
 *
 * mode 'timing' records only the time and step of each display draw, no
 * readback: a per-draw readback costs more than this renderer does (body
 * lane: 0.3-0.4 ms script, 16.7 ms frames at 60 Hz), so frame time must be
 * measured without it in the loop. */
export const SAMPLER_INIT = (preset) => {
  /* `preset` arms the sampler from the first draw -- before boot -- so a page
     that is never focused, whose loop pauses after the boot burst, still
     yields its boot draws for a readback judgement. */
  const gate = { armed: false, mode: 'pixels', size: 128, frames: [], max: 400, error: null, lastSteps: null, ...(preset || {}) }
  window.__jellyGate = gate
  for (const kind of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const proto = window[kind] && window[kind].prototype
    if (!proto || !proto.drawArrays) continue
    const original = proto.drawArrays
    proto.drawArrays = function (...args) {
      const result = original.apply(this, args)
      if (!gate.armed) return result
      try {
        if (!this.canvas || !this.canvas.classList || !this.canvas.classList.contains('home-circle-fluid')) return result
        if (this.getParameter(this.FRAMEBUFFER_BINDING)) return result
        let steps = null
        try { const r = document.querySelector('.home-circle'); steps = r && r.homeCircleFluid ? r.homeCircleFluid.stats().steps : null } catch (e) { steps = null }
        if (gate.mode === 'timing') {
          if (steps === gate.lastSteps) return result
          gate.lastSteps = steps
          if (gate.frames.length >= gate.max) gate.frames.shift()
          gate.frames.push({ t: performance.now(), steps })
          return result
        }
        const w = this.drawingBufferWidth, h = this.drawingBufferHeight
        const px = new Uint8Array(w * h * 4)
        this.readPixels(0, 0, w, h, this.RGBA, this.UNSIGNED_BYTE, px)
        const size = gate.size, out = new Uint8ClampedArray(size * size * 4)
        for (let y = 0; y < size; y++) {
          const sy = h - 1 - Math.floor((y + 0.5) * h / size)
          for (let x = 0; x < size; x++) {
            const sx = Math.floor((x + 0.5) * w / size)
            const i = (sy * w + sx) * 4, o = (y * size + x) * 4
            out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; out[o + 3] = 255
          }
        }
        if (gate.frames.length >= gate.max) gate.frames.shift()
        gate.frames.push({ t: performance.now(), steps, data: out, w, h })
      } catch (e) { gate.error = String(e) }
      return result
    }
  }
}

export async function armSampler (page, { size = 128, max = 400, mode = 'pixels' } = {}) {
  await page.evaluate(({ size, max, mode }) => { const g = window.__jellyGate; g.frames = []; g.size = size; g.max = max; g.mode = mode; g.lastSteps = null; g.error = null; g.armed = true }, { size, max, mode })
}

/* Stop sampling and pull the frames out as raw RGBA. The canvas has no alpha
   ground of its own here -- `ground` is what the sampler composited over, which
   is the page ground behind a transparent canvas: the 2D copy is drawn on a
   cleared (transparent black) canvas, so the ground is [0,0,0] for anything the
   body did not cover. That is exactly the ink field the measures want. */
export async function drainSampler (page) {
  const out = await page.evaluate(() => {
    const g = window.__jellyGate
    g.armed = false
    const frames = g.frames.map(f => {
      if (!f.data) return { t: f.t, steps: f.steps, b64: null }
      let s = ''
      const d = f.data
      for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, Math.min(i + 8192, d.length)))
      return { t: f.t, steps: f.steps, b64: btoa(s) }
    })
    const size = g.size, error = g.error || null
    g.frames = []
    return { frames, size, error }
  })
  return { size: out.size, error: out.error, frames: out.frames.map(f => ({ t: f.t, steps: f.steps, width: out.size, height: out.size, data: f.b64 ? Buffer.from(f.b64, 'base64') : null })) }
}

/* Resample a timestamped series onto a fixed step by nearest sample, so the
   pure measures can assume a constant dt. Returns the series and the step. */
export function resample (frames, pick, dtMs = 1000 / 60) {
  if (!frames.length) return { series: [], dtMs }
  const t0 = frames[0].t, t1 = frames[frames.length - 1].t
  const series = []
  let j = 0
  for (let t = t0; t <= t1; t += dtMs) {
    while (j + 1 < frames.length && Math.abs(frames[j + 1].t - t) <= Math.abs(frames[j].t - t)) j++
    series.push(pick(frames[j], j))
  }
  return { series, dtMs }
}

/* Compose a strip of frames into one PNG, in the page (no image dependency). */
export async function composeStrip (page, frames, { scale = 2, labels = [] } = {}) {
  const payload = frames.map(f => ({ width: f.width, height: f.height, b64: Buffer.from(f.data).toString('base64') }))
  const b64 = await page.evaluate(async ({ payload, scale, labels }) => {
    const w = payload[0].width * scale, h = payload[0].height * scale
    const c = new OffscreenCanvas(w * payload.length, h + 18)
    const g = c.getContext('2d')
    g.fillStyle = '#222'; g.fillRect(0, 0, c.width, c.height)
    g.imageSmoothingEnabled = false
    for (let k = 0; k < payload.length; k++) {
      const p = payload[k]
      const bytes = Uint8ClampedArray.from(atob(p.b64), ch => ch.charCodeAt(0))
      const img = new ImageData(bytes, p.width, p.height)
      const tmp = new OffscreenCanvas(p.width, p.height)
      tmp.getContext('2d').putImageData(img, 0, 0)
      g.drawImage(tmp, k * w, 18, w, h)
      g.fillStyle = '#eee'; g.font = '12px sans-serif'; g.fillText(labels[k] || String(k), k * w + 4, 13)
    }
    const blob = await c.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + 8192, buf.length)))
    return btoa(s)
  }, { payload, scale, labels })
  return Buffer.from(b64, 'base64')
}

/* Compose PNG panels side by side at matched height, in the page. `panels` are
   {png: Buffer, label}. Returns a PNG buffer. */
export async function composeSheet (page, panels, { height = 320 } = {}) {
  const payload = panels.map(p => ({ b64: p.png.toString('base64'), label: p.label }))
  const b64 = await page.evaluate(async ({ payload, height }) => {
    const bitmaps = []
    for (const p of payload) {
      const bytes = Uint8Array.from(atob(p.b64), ch => ch.charCodeAt(0))
      bitmaps.push(await createImageBitmap(new Blob([bytes], { type: 'image/png' })))
    }
    const widths = bitmaps.map(b => Math.round(b.width * height / b.height))
    const c = new OffscreenCanvas(widths.reduce((t, v) => t + v + 8, 8), height + 26)
    const g = c.getContext('2d')
    g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, c.width, c.height)
    let x = 8
    for (let k = 0; k < bitmaps.length; k++) {
      g.drawImage(bitmaps[k], x, 22, widths[k], height)
      g.fillStyle = '#eee'; g.font = '13px sans-serif'; g.fillText(payload[k].label, x, 15)
      x += widths[k] + 8
    }
    const blob = await c.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + 8192, buf.length)))
    return btoa(s)
  }, { payload, height })
  return Buffer.from(b64, 'base64')
}

/* Crop a PNG (in the page) to a rectangle, returning a PNG. */
export async function cropPng (page, png, { x, y, width, height }) {
  const b64 = await page.evaluate(async ({ b64, x, y, width, height }) => {
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = new OffscreenCanvas(width, height)
    c.getContext('2d').drawImage(bmp, x, y, width, height, 0, 0, width, height)
    const blob = await c.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + 8192, buf.length)))
    return btoa(s)
  }, { b64: png.toString('base64'), x, y, width, height })
  return Buffer.from(b64, 'base64')
}

/* PIN a state. MEASURED 2026-09-18: holdForm confirmed the renderer on the
   idle form, and 300 ms later the sampled frames showed the tool-orbit bands --
   the Home view's example fleet had repainted data-agent-action underneath the
   capture. A one-shot set is a request the view overrides on its next tick, so
   the wanted attributes are re-asserted from a MutationObserver the instant
   anything else writes them. Unpin with pinState(page, null). */
export async function pinState (page, state) {
  await page.evaluate((s) => {
    const r = document.querySelector('.home-circle')
    if (!r) return
    if (r.__jellyPin) { r.__jellyPin.disconnect(); r.__jellyPin = null }
    if (!s) return
    /* FIVE attributes, not two (body lane, det.mjs, 2026-09-18): the example
       fleet's repaints of key, name and event start agent-change episodes at
       wall-clock times, so two seeded runs diverged at frame 15 until those
       were pinned as well. */
    const apply = () => {
      if (r.dataset.agentAction !== s.action) r.dataset.agentAction = s.action
      if ((r.dataset.agentTool || '') !== (s.tool || '')) r.dataset.agentTool = s.tool || ''
      if (s.phase !== undefined && (r.dataset.activityPhase || '') !== (s.phase || '')) r.dataset.activityPhase = s.phase || ''
      if (s.key !== undefined && (r.dataset.agentKey || '') !== s.key) r.dataset.agentKey = s.key
      if (s.name !== undefined && (r.dataset.agentName || '') !== s.name) r.dataset.agentName = s.name
      if (s.event !== undefined && (r.dataset.agentEvent || '') !== s.event) r.dataset.agentEvent = s.event
    }
    apply()
    const mo = new MutationObserver(apply)
    mo.observe(r, { attributes: true, attributeFilter: ['data-agent-action', 'data-agent-tool', 'data-activity-phase', 'data-agent-key', 'data-agent-name', 'data-agent-event'] })
    r.__jellyPin = mo
  }, state)
}

/* Pin a state and wait for the renderer to report its form. */
export async function pinForm (page, { action, tool = '', form, tries = 40, key, name, event }) {
  await pinState(page, { action, tool, key, name, event })
  let got = null
  for (let i = 0; i < tries; i++) {
    got = await formOf(page)
    if (got === form) return got
    await page.waitForTimeout(250)
  }
  throw new Error(`pinForm(${action}): renderer stayed on form ${got}, wanted ${form}`)
}

/* Only the frames the renderer actually drew: the sampler fires after EVERY
   rAF callback and other callbacks in the same frame read a blank buffer. */
export function liveFrames (frames, ground = [0, 0, 0], threshold = 24) {
  return frames.filter(f => {
    const d = f.data
    if (!d) return false
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - ground[0]) + Math.abs(d[i + 1] - ground[1]) + Math.abs(d[i + 2] - ground[2]) > threshold * 3) return true
    return false
  })
}
