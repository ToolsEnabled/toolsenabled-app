'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw new Error('An existing real isolated output directory is required')
app.setName('ToolsEnabled Isolated Computers Status Layout')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key); fs.mkdirSync(directory); app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const report = { versions: process.versions, platform: process.platform, rows: [], pageErrors: [], deniedRequests: [], destroyed: false }
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url.startsWith('data:')
    if (details.url.startsWith('file:')) allowed = path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message) })
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  try {
    await win.loadFile(path.join(data, 'index.html'))
    for (const width of [320, 768, 1440]) {
      win.setContentSize(width, 900)
      for (const split of [false, true]) {
        await evaluate('computersLayout.mount(' + split + ')')
        for (const kind of ['empty', 'hidden', 'success', 'refusal', 'long-success', 'long-refusal']) {
          report.rows.push(await evaluate('computersLayout.measure(' + JSON.stringify(kind) + ')'))
          if (kind === 'long-refusal') fs.writeFileSync(path.join(data, width + '-' + split + '.png'), (await win.webContents.capturePage()).toPNG())
        }
        // Restore hints after the visible message has been replaced.
        report.rows.push(await evaluate('computersLayout.measure("empty")'))
        await evaluate('computersLayout.dispose()')
      }
    }
    report.operations = await evaluate('computersLayout.operations')
    report.visible = win.isVisible()
  } finally {
    if (win && !win.isDestroyed()) {
      try { await evaluate('computersLayout.dispose()') } finally { win.destroy() }
    }
    report.destroyed = !!win?.isDestroyed()
  }
  fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
  app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }
  if (win && !win.isDestroyed()) win.destroy()
  report.destroyed = !!win?.isDestroyed()
  fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
  app.exit(1)
})
