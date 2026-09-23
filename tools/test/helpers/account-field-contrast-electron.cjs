'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'); const path = require('node:path'); const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw Error('Real isolated output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const dir = path.join(data, key); fs.mkdirSync(dir); app.setPath(key, dir) }
app.disableHardwareAcceleration()
const report = { cases: [], pageErrors: [], deniedRequests: [] }; let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('data:') || (details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data); if (!allowed) report.deniedRequests.push(details.url); callback({ cancel: !allowed }) })
  win = new BrowserWindow({ show: false, width: 1400, height: 900, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', d => { if (d.level === 'error') report.pageErrors.push(d.message) })
  await win.loadFile(path.join(data, 'index.html'))
  for (const theme of ['white', 'tan', 'black', 'ember', 'cobalt']) for (const surface of ['account', 'setup']) {
    const observed = await win.webContents.executeJavaScript(`accountFieldContrast.measure(${JSON.stringify({ theme, surface })})`, true)
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true)
    report.cases.push({ theme, surface, observed })
    fs.writeFileSync(path.join(data, `fields-${surface}-${theme}.png`), (await win.webContents.capturePage()).toPNG())
  }
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed(); save(); app.exit(0)
}).catch(error => { report.failure = { message: error.message, stack: error.stack }; save(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1) })
