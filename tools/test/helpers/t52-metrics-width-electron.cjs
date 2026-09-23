'use strict'

/* T52(3). The page column of four routes, at three window widths, read from a
   real rendered window. Geometry is the right instrument here -- unlike the
   header band, nothing is hidden behind pointer-events, and the question is
   literally "how wide is the box". */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) {
  throw Error('Real isolated output required')
}
app.setName('ToolsEnabled isolated metrics width')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()

/* Full, half and narrow, as the assignment names them, plus the breakpoint
   neighbours: --page-gutter is clamp(20px, 2.4vw, 40px), so it stops growing at
   1667px and bottoms out at 833px. A jump, if there is one, lives at those two
   widths and an evenly spaced sample would step straight over it. */
const WIDTHS = [1920, 1668, 1666, 1440, 960, 834, 832, 560]
const PAGES = ['computers', 'ledger', 'settings', 'metrics']

const report = { rows: [], pageErrors: [], deniedRequests: [] }
let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})

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

  for (const width of WIDTHS) {
    win.setContentSize(width, 900)
    await new Promise(resolve => setTimeout(resolve, 150))
    for (const page of PAGES) {
      const row = await win.webContents.executeJavaScript(`t52Metrics.measure(${JSON.stringify(page)})`, true)
      row.requestedWidth = width
      report.rows.push(row)
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
