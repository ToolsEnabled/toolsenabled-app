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
// DOM animation frames can settle before the offscreen compositor has resized.
// Require a fresh complete frame at the measured pixel size before capturePage.
function waitForTargetPaint(width, height, scale) {
  const expected = { width: Math.round(width * scale), height: Math.round(height * scale) }
  return new Promise((resolve, reject) => {
    let lastSize = null
    const finish = (error, size) => {
      clearTimeout(timer); win.webContents.removeListener('paint', onPaint)
      if (error) reject(error); else resolve(size)
    }
    const onPaint = (_event, _dirty, image) => {
      if (image.isEmpty()) return
      lastSize = image.getSize()
      if (lastSize.width === expected.width && lastSize.height === expected.height) finish(null, lastSize)
    }
    const timer = setTimeout(() => finish(Error('Offscreen Accounts frame did not reach ' + expected.width + 'x' + expected.height + '; last paint: ' + JSON.stringify(lastSize))), 5000)
    win.webContents.on('paint', onPaint)
    try { win.webContents.invalidate() } catch (error) { finish(error) }
  })
}
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
    const viewport = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })', true)
    if (viewport.width !== width || viewport.height !== 1000 || !Number.isFinite(viewport.scale) || viewport.scale <= 0) throw Error('Accounts capture viewport did not reach its requested size')
    const painted = await waitForTargetPaint(width, 1000, viewport.scale)
    const capture = await win.webContents.capturePage()
    const captured = capture.getSize()
    if (capture.isEmpty() || captured.width !== painted.width || captured.height !== painted.height) throw Error('Accounts capture does not match its measured compositor frame')
    fs.writeFileSync(path.join(data, `accounts-${width}.png`), capture.toPNG())
    ;(report.captures ||= []).push({ width, viewport, painted, captured })
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
