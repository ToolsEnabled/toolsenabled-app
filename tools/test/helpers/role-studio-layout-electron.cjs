'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw new Error('An existing real isolated output directory is required')
app.setName('ToolsEnabled Isolated Role Layout')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const report = { versions: process.versions, platform: process.platform, data, rows: [], pageErrors: [], deniedRequests: [] }
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url.startsWith('data:')
    if (details.url.startsWith('file:')) allowed = path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message) })
  await win.loadFile(path.join(data, 'index.html'))
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  for (const [width, height] of [[1280, 900], [1024, 768], [600, 800]]) {
    win.setContentSize(width, height)
    for (const font of ['plex', 'system', 'mono']) for (const size of [0.9, 1, 1.12]) {
      const row = await evaluate(`roleLayout.open(${JSON.stringify(font)}, ${size})`)
      row.views = []
      for (const view of ['canvas', 'directions', 'functions', 'preview', 'reset', 'new']) {
        row.views.push(await evaluate(`roleLayout.measure(${JSON.stringify(view)})`))
        if (font === 'plex' && size === 1.12 && ['canvas', 'directions', 'new'].includes(view)) {
          fs.writeFileSync(path.join(data, `${width}-large-${view}.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
      // Send real input only when the native hit-test confirms the Close target.
      const point = await evaluate('roleLayout.closePoint()')
      row.closePoint = point
      if (point.hittable && point.x >= 0 && point.y >= 0 && point.x < width && point.y < height) {
        const position = { x: Math.round(point.x), y: Math.round(point.y) }
        win.webContents.sendInputEvent({ type: 'mouseMove', ...position })
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
        // Input is queued to the renderer; wait for its close handler to run.
        for (let attempt = 0; attempt < 50 && await evaluate('roleLayout.isOpen()'); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      row.closedByInput = !await evaluate('roleLayout.isOpen()')
      row.sidebarHiddenAfterClose = await evaluate('roleLayout.sidebarHidden()')
      report.rows.push(row)
    }
  }
  report.operations = await evaluate('roleLayout.operations')
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
