'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'); const path = require('node:path'); const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw Error('Real isolated output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const dir = path.join(data, key); fs.mkdirSync(dir); app.setPath(key, dir) }
app.disableHardwareAcceleration()
const report = { scenarios: {}, pageErrors: [], deniedRequests: [] }; let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('data:') || (details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data); if (!allowed) report.deniedRequests.push(details.url); callback({ cancel: !allowed }) })
  win = new BrowserWindow({ show: false, width: 1400, height: 900, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', d => { if (d.level === 'error') report.pageErrors.push(d.message) })
  await win.loadFile(path.join(data, 'index.html'))
  /* A hidden offscreen window's page never has focus, so nothing it focuses
     would be the active element; focus emulation gives it the focus a shown
     window has. */
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (const [name, call] of [['walkthroughNo', 'walkthrough("no")'], ['walkthroughYes', 'walkthrough("yes")'], ['settingsNo', 'settings("no")'], ['settingsYes', 'settings("yes")']]) {
    report.scenarios[name] = await win.webContents.executeJavaScript(`riskGateFocus.${call}`, true)
  }
  win.webContents.debugger.detach(); report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed(); save(); app.exit(0)
}).catch(error => { report.failure = { message: error.message, stack: error.stack }; save(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1) })
