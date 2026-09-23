/* Electron main for the crescent measurement harness.
 *
 * Opens ONE offscreen window, walks every (theme, load) combination, and writes
 * each frame as raw BGRA plus a small JSON of the geometry it was taken in.
 * Raw, not PNG, because `nativeImage.toBitmap()` hands back the pixels already
 * and decoding a PNG again would add a dependency this repo does not have and
 * a chance to be wrong.
 *
 * Three things here were each learned the hard way on this machine:
 *
 *   1. OFFSCREEN rendering, not a hidden window. A plain `show: false` window
 *      returns a 1x image no matter what `force-device-scale-factor` says —
 *      measured, 782x504 for a 782x504 window at scale 2 — which would have
 *      silently thrown away the entire point of measuring at retina density.
 *      Offscreen honours it: a 400x300 window yields an 800x600 buffer. It is
 *      also software-composited, so the reference is reproducible rather than
 *      being whatever this GPU driver did that day.
 *   2. A settle delay before the first capture. `capturePage()` on a window
 *      that has not composited a frame yet rejects with `UnknownVizError`,
 *      which reads like a driver fault and is really just "too early".
 *   3. Errors go to a FILE. The Electron executable is a GUI-subsystem binary
 *      on Windows with no console attached, so console.error is discarded and
 *      a failure presents as a bare non-zero exit with no explanation.
 *
 * The window is never shown — the desktop stays quiet (R193).
 *
 * Usage: electron tools/ring-capture-main.cjs --url <base> --out <dir> --scale 2
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

/* Configuration arrives by environment, not on the command line. Electron hands
   its argv to Chromium's switch parser first, and while any ONE of --url/--out/
   --scale survives that intact, the full set does not: measured here, the
   process dies with exit -1 before this script is ever evaluated — no output,
   no trace, nothing to read. Environment variables are not parsed by anyone
   else, so they simply arrive. */
const env = process.env
const BASE = env.RING_URL || 'http://127.0.0.1:4733'
const OUT = env.RING_OUT || path.join(process.cwd(), 'artifacts', 'ring-fidelity')
const SCALE = Number(env.RING_SCALE || '2')
const SIZE = Number(env.RING_SIZE || '520')
const THEMES = (env.RING_THEMES || 'white,tan,black').split(',')
const LOADS = (env.RING_LOADS || 'idle,busy,peak,unknown').split(',')

const WIN_W = 1000
const WIN_H = 900

app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE))

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/* Progress goes to a file for the same reason errors do (note 3 above): with no
   console attached, this trace is the only way to see where a run stopped. */
const trace = (m) => {
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.appendFileSync(path.join(OUT, 'capture.log'), `${new Date().toISOString()} ${m}\n`)
  } catch { /* nothing left to do */ }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  trace(`main: electron ${process.versions.electron}, base ${BASE}, scale ${SCALE}`)

  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  win.webContents.setFrameRate(30)

  /* THE OS MOTION PREFERENCE IS PINNED, so the measurement is of the DESIGN
     and not of this machine's accessibility settings.
     MEASURED 2026-08-19: with Windows' reduce-motion flag on, this harness
     read 15 measurements outside tolerance across every theme — endRoll
     halved, centroid rotated ~8°, mass down 15-34% — on a tree with NO
     commit touching the crescent since the baseline was recorded, because
     src/styles.css's `@media (prefers-reduced-motion: reduce)` block
     (animation-duration 0.001ms, one iteration) collapses every sheet
     animation the moment the OS flag is on. The fixture already pins the
     CLASS half of reduced motion deliberately (body.reduce-motion,
     tools/ring-fixture.html) — the media half was the one axis left to
     whatever machine ran the capture, and the reference at
     tools/test/fixtures/crescent-reference-metrics.json was recorded with it
     off. Emulation pins it off everywhere, the same policy
     tools/page2-qa.cjs already applies with its matchMedia stub: measure the
     same CSS on any machine. The accessibility behaviour itself is asserted
     behaviourally by page2's reduce-motion check, not by this ruler. */
  /* Attached once here; the pin itself is (re)sent after every load below —
     sending it before the first document has committed was measured to hang
     the sendCommand promise without a word. */
  win.webContents.debugger.attach('1.3')
  const pinMotionPreference = async () => {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    trace('emulation: prefers-reduced-motion pinned to no-preference')
  }

  const manifest = []
  for (const theme of THEMES) {
    for (const load of LOADS) {
      const url = `${BASE}/tools/ring-fixture.html?size=${SIZE}&theme=${theme}&load=${load}`
      trace(`loading ${theme}/${load}`)
      await win.loadURL(url)
      await pinMotionPreference()
      await win.webContents.executeJavaScript(
        `new Promise((resolve, reject) => {
          const deadline = Date.now() + 30000
          const check = () => {
            if (window.__ringReady) return resolve(true)
            if (Date.now() >= deadline) return reject(new Error('ring fixture did not become ready within 30 seconds'))
            setTimeout(check, 16)
          }
          check()
        })`
      )
      const geom = await win.webContents.executeJavaScript(
        `({ ...window.__ringGeom, dpr: window.devicePixelRatio,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight })`
      )
      // See note 2 above: without this the first frame is not composited yet.
      win.webContents.invalidate()
      await sleep(350)

      const image = await win.webContents.capturePage()
      const bitmap = image.toBitmap()

      /* Neither `image.getSize()` nor `window.devicePixelRatio` can be trusted
         to give the scale here: getSize()'s units differ between the offscreen
         and windowed paths, and — measured — an offscreen page reports
         devicePixelRatio 1 while its backing buffer is genuinely 2x
         (1000x690 CSS arriving as 2,760,000 pixels). Believing the page cost a
         run where every sample landed at half its intended position.
         The buffer's own pixel count against the page's CSS box is the one
         statement that is true in both modes. */
      const total = bitmap.length / 4
      const scale = Math.sqrt(total / (geom.innerWidth * geom.innerHeight))
      const width = Math.round(geom.innerWidth * scale)
      const height = Math.round(total / width)

      const name = `${theme}-${load}`
      fs.writeFileSync(path.join(OUT, `${name}.bgra`), bitmap)
      fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG())
      manifest.push({ name, theme, load, width, height, scale, geom })
      trace(`captured ${name} ${width}x${height} scale=${scale} css=${geom.innerWidth}x${geom.innerHeight} bytes=${bitmap.length}`)
    }
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    size: SIZE, requestedScale: SCALE, capturedWith: 'electron-offscreen', frames: manifest,
  }, null, 2))

  win.destroy()
  app.quit()
}

function fail(err) {
  const msg = `capture failed: ${(err && err.stack) || err}\n`
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'capture-error.log'), msg)
  } catch { /* nothing left to do */ }
  process.exitCode = 1
  app.quit()
}

process.on('uncaughtException', fail)

trace('script evaluated')
app.whenReady().then(() => { trace('app ready'); main().catch(fail) })
