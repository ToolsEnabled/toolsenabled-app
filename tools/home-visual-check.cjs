/* Photograph the real /home view, offscreen, in every theme.
 *
 * The fixture next door isolates the crescent so it can be MEASURED. This
 * renders the actual page — the hero in its grid, beside the braces and the
 * session panel — so it can be LOOKED AT, which is the only way to answer
 * whether the light still sits right on the page rather than merely scoring
 * well. Offscreen, so nothing appears on the desktop (R193).
 *
 * Config by environment, for the reason ring-capture-main.cjs records.
 *   HOME_URL    base of a running dev server
 *   HOME_OUT    directory for the PNGs
 *   HOME_SIZE   window size as WxH, defaulting to the owner's 1920x1080
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const BASE = process.env.HOME_URL || 'http://127.0.0.1:4733'
const OUT = process.env.HOME_OUT || path.join(process.cwd(), 'artifacts', 'home-visual')
const [W, H] = (process.env.HOME_SIZE || '1920x1080').split('x').map(Number)
const THEMES = (process.env.HOME_THEMES || 'tan,white,black').split(',')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const trace = (m) => {
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.appendFileSync(path.join(OUT, 'visual.log'), `${new Date().toISOString()} ${m}\n`)
  } catch { /* no console attached to read it anyway */ }
}

app.commandLine.appendSwitch('force-device-scale-factor', '2')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  win.webContents.setFrameRate(30)

  for (const theme of THEMES) {
    await win.loadURL(`${BASE}/#/`)
    // The theme is read from storage before first paint, so it is set and the
    // document is then genuinely RELOADED. Calling loadURL with the same URL a
    // second time is not a reload — it resolves as a same-document hash
    // navigation, the pre-paint script never runs again, and every theme comes
    // back byte-identical to the first.
    await win.webContents.executeJavaScript(
      `localStorage.setItem('mc.theme', ${JSON.stringify(theme)}); true`
    )
    await new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve)
      win.webContents.reload()
    })
    /* Long enough for the masks to be rasterised, handed back from the worker,
       encoded and applied. Measured at about 53ms of compute; this is generous
       on purpose because a screenshot taken early would silently show the
       crescent missing and read as a bug in the render. */
    await sleep(2500)
    win.webContents.invalidate()
    await sleep(400)

    const ready = await win.webContents.executeJavaScript(
      `(() => { const ring = document.querySelector('.uring.crescent')
                const gl = document.querySelector('.cres-gl')
                const cpu = document.querySelector('.cres-layers')
                const probe = document.querySelector('.cres-probe')
                const cs = ring ? getComputedStyle(ring) : null
                return { theme: document.documentElement.dataset.theme || null,
                         mode: ring ? ring.crescentMode : null,
                         canvas: !!gl,
                         cpuReady: cpu ? cpu.dataset.ready === '1' : false,
                         probe: !!probe,
                         blend: gl ? getComputedStyle(gl).mixBlendMode : null,
                         colour: probe ? getComputedStyle(probe).backgroundColor : null,
                         glow: cs ? cs.getPropertyValue('--glow').trim() : null,
                         dose: cs ? cs.getPropertyValue('--cres-halo-o').trim() : null,
                         load: ring ? ring.dataset.load : null } })()`
    )
    trace(`${theme}: ${JSON.stringify(ready)}`)

    const rendered = ready.mode === 'gl' ? ready.canvas : ready.mode === 'cpu' && ready.cpuReady
    if (ready.theme !== theme || !ready.probe || !rendered) {
      throw new Error(`home crescent was not ready for ${theme}: ${JSON.stringify(ready)}`)
    }

    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `home-${theme}.png`), image.toPNG())
    trace(`${theme}: wrote png`)
  }

  win.destroy()
  app.quit()
}

function fail(err) {
  trace(`FAILED ${(err && err.stack) || err}`)
  process.exitCode = 1
  app.quit()
}
process.on('uncaughtException', fail)
app.whenReady().then(() => main().catch(fail))
