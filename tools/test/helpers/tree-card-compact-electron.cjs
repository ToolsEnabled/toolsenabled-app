'use strict'

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) {
  throw Error('Real isolated output required')
}
app.setName('ToolsEnabled isolated card layout')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()

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
    show: false, width: 1440, height: 920, useContentSize: true,
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
  for (const style of ['boxes', 'circles']) {
    for (const size of ['mini', 'small', 'medium', 'large']) {
      const row = await win.webContents.executeJavaScript(
        `cardLayout.measure(${JSON.stringify(size)}, ${JSON.stringify(style)})`, true)
      const screenshot = await win.webContents.capturePage()
      fs.writeFileSync(path.join(data, `${style}-${size}.png`), screenshot.toPNG())
      const count = await win.webContents.executeJavaScript('cardLayout.focusCard()', true)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await new Promise(resolve => setTimeout(resolve, 80))
      // Boxes open their conversation; detached context cards open controls.
      row.keyboardOpened = style === 'boxes'
        ? await win.webContents.executeJavaScript('cardLayout.chatIsOpen()', true)
        : (await win.webContents.executeJavaScript('cardLayout.keyboardEvents()', true)).length > count
      report.rows.push(row)
    }
  }
  report.toolbarMini = await win.webContents.executeJavaScript('cardLayout.toolbarMini()', true)
  fs.writeFileSync(path.join(data, 'toolbar-mini.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript('cardLayout.dispose()', true)
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
