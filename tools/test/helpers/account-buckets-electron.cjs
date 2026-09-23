'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw Error('Real isolated output required')
app.setName('ToolsEnabled isolated account buckets')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key); fs.mkdirSync(directory); app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const report = { rows: [], pageErrors: [], deniedRequests: [] }
let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('data:') || details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({ show: false, width: 1120, height: 1000, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message) })
  await win.loadFile(path.join(data, 'index.html'))
  await win.webContents.executeJavaScript('accountBucketsFixture.open()', true)
  for (const width of [1120, 600]) {
    win.setContentSize(width, 1000)
    report.rows.push({ width, ...await win.webContents.executeJavaScript('accountBucketsFixture.measure()', true) })
    fs.writeFileSync(path.join(data, `accounts-${width}.png`), (await win.webContents.capturePage()).toPNG())
  }
  report.invalidation = await win.webContents.executeJavaScript('accountBucketsFixture.failThenRebind()', true)
  await win.webContents.executeJavaScript('accountBucketsFixture.dispose()', true)
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed()
  save(); app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }; save()
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(1)
})
