'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw new Error('An existing real isolated output directory is required')
app.setName('ToolsEnabled Isolated Chat Layout')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const report = { platform: process.platform, versions: process.versions, rows: [], pageErrors: [], deniedRequests: [] }
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url.startsWith('data:')
    if (details.url.startsWith('file:')) allowed = path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({ show: false, width: 844, height: 700, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message) })
  await win.loadFile(path.join(data, 'index.html'))
  for (const [width, zoom] of [[844, 1], [600, 1.12]]) {
    win.setContentSize(width, 700)
    report.rows.push({ width, ...await win.webContents.executeJavaScript(`chatReadability.measure(${zoom})`, true) })
    fs.writeFileSync(path.join(data, `${width}-chat.png`), (await win.webContents.capturePage()).toPNG())
  }
  report.visible = win.isVisible()
  win.destroy()
  report.destroyed = win.isDestroyed()
  fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
  app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }
  fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(1)
})
