'use strict'

/* T52(2). The band above the top bar, PROVED BY PIXELS rather than by geometry.
 *
 * Geometry alone cannot answer the owner's complaint. `elementFromPoint` is
 * useless here on purpose: the cover keeps `pointer-events: none` so it does
 * not start swallowing clicks, which means hit-testing looks straight through
 * it and would report the page text as "on top" whether it is painted or not.
 * So this reads the window's actual pixels: scroll a long, dark, dense page and
 * check that the strip above the controls is still nothing but the page
 * background colour.
 */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) {
  throw Error('Real isolated output required')
}
app.setName('ToolsEnabled isolated header cover')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()

const WIDTHS = [1440, 1120, 2560]
/* 0 proves the resting state; the rest are far enough in that a 15px line has
   certainly crossed the band. */
const SCROLLS = [0, 40, 120, 600, 2000]
/* The bar sits at top:14px and is 44px tall. The strip THE OWNER SEES TEXT IN
   is the 14px above it; that is what must be empty. The 44px the controls
   occupy is chrome and legitimately carries the wordmark, so it is not
   sampled -- a gate that demanded a blank bar would fail on the product's own
   header. */
const BAND_TOP = 0
const BAND_BOTTOM = 14

const report = { rows: [], pageErrors: [], deniedRequests: [] }
let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})

/* Every pixel of the strip, as BGRA out of the captured bitmap. Returns the
   distinct colours found and a small sample of offenders, so a failure names
   what was painted instead of only that something was. */
function strip(image, contentWidth, contentHeight) {
  const size = image.getSize()
  const bitmap = image.getBitmap()
  const scale = size.width / contentWidth
  const top = Math.round(BAND_TOP * scale)
  const bottom = Math.max(top + 1, Math.round(BAND_BOTTOM * scale))
  const colours = new Map()
  for (let y = top; y < bottom && y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const i = (y * size.width + x) * 4
      const key = `${bitmap[i + 2]},${bitmap[i + 1]},${bitmap[i]}`
      const seen = colours.get(key)
      if (seen) seen.count += 1
      else colours.set(key, { count: 1, firstAt: { x, y } })
    }
  }
  const rows = [...colours.entries()].map(([rgb, info]) => ({ rgb, ...info }))
    .sort((a, b) => b.count - a.count)
  return { scale, sampledRows: Math.max(0, bottom - top), imageSize: size, contentHeight, colours: rows.slice(0, 8), distinct: rows.length }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('data:') || details.url.startsWith('file:')
      && path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({
    show: false, width: WIDTHS[0], height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => {
    if (details.level === 'error') report.pageErrors.push(details.message)
  })
  await win.loadFile(path.join(data, 'index.html'))
  await win.webContents.executeJavaScript('t52Header.ready()', true)

  for (const width of WIDTHS) {
    win.setContentSize(width, 900)
    await new Promise(resolve => setTimeout(resolve, 150))
    for (const scrollTop of SCROLLS) {
      await win.webContents.executeJavaScript(`t52Header.scrollTo(${scrollTop})`, true)
      const measured = await win.webContents.executeJavaScript('t52Header.measure()', true)
      const image = await win.webContents.capturePage()
      const band = strip(image, width, 900)
      if (scrollTop === 600 && width === WIDTHS[0]) {
        fs.writeFileSync(path.join(data, `header-${width}-${scrollTop}.png`), image.toPNG())
      }
      report.rows.push({ requestedWidth: width, requestedScroll: scrollTop, ...measured, band })
      save()
    }
  }
  report.visible = win.isVisible()
  win.destroy()
  report.destroyed = win.isDestroyed()
  save()
  app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }
  save()
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(1)
})
