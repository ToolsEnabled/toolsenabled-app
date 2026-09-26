'use strict'

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) {
  throw Error('Real isolated output required')
}
app.setName('ToolsEnabled isolated top bar snap')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()

/* The three the assignment named, and the odd companion of each: with a
   --page-gutter of 16px the centred bar is 1240px wide from 1272px up, so the
   true centre falls on a half pixel exactly when the window width is odd. An
   even-only sample would pass without the fix. */
const WIDTHS = [1440, 1441, 1120, 1121, 2560, 2561]
const report = { rows: [], resting: null, pageErrors: [], deniedRequests: [] }
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
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => {
    if (details.level === 'error') report.pageErrors.push(details.message)
  })
  await win.loadFile(path.join(data, 'index.html'))
  for (const width of WIDTHS) {
    win.setContentSize(width, 900)
    await new Promise(resolve => setTimeout(resolve, 120))
    for (const route of ['default', 'sidebar']) {
      const row = await win.webContents.executeJavaScript(
        `topbarSharpness.measure(${JSON.stringify(route)})`, true)
      row.requestedWidth = width
      report.rows.push(row)
    }
  }
  win.setContentSize(WIDTHS[0], 900)
  await new Promise(resolve => setTimeout(resolve, 120))
  report.resting = await win.webContents.executeJavaScript('topbarSharpness.resting()', true)
  fs.writeFileSync(path.join(data, 'topbar.png'), (await win.webContents.capturePage()).toPNG())
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
