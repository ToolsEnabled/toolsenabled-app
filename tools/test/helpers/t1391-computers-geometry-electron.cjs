'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw new Error('An existing real isolated output directory is required')
app.setName('ToolsEnabled Isolated Computers Additions')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key); fs.mkdirSync(directory); app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const report = { versions: process.versions, platform: process.platform, edits: [], phones: [], graph: null,
  pageErrors: [], deniedRequests: [], operations: [], destroyed: false }
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
  const click = ({ x, y }) => {
    x = Math.round(x); y = Math.round(y)
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y })
  }
  const dispose = async () => {
    report.operations.push(...await evaluate('computersGeometry.operations'))
    await evaluate('computersGeometry.dispose()')
  }
  const load = async (width, height, options) => {
    win.setContentSize(width, height)
    await win.loadFile(path.join(data, 'index.html'))
    return evaluate('computersGeometry.mount(' + JSON.stringify(options) + ')')
  }
  try {
    for (const width of [320, 768, 1440]) for (const trees of [1, 2]) {
      await load(width, 900, { trees })
      report.edits.push(await evaluate('computersGeometry.edit(' + trees + ')'))
      await dispose()
    }
    for (const [width, height] of [[750, 342], [863, 360], [412, 839]]) {
      const mode = await load(width, height, { phone: true, rows: true })
      const before = await evaluate('computersGeometry.prepareRows()')
      const row = { mode, before, clicks: [] }
      report.phones.push(row)
      if (before.usable.length < 2) throw new Error('Fewer than two complete hit-tested rows at ' + width + 'x' + height)
      for (const expected of before.usable.slice(0, 2)) {
        const current = await evaluate('computersGeometry.rows()')
        const target = current.usable.find(item => item.name === expected.name)
        if (!target) throw new Error('Retained row is no longer a complete hit target')
        click(target.center)
        const opened = await evaluate('computersGeometry.openedRow()')
        row.clicks.push({ expected: target.name, ...opened })
        if (!opened.visible || !opened.close) throw new Error('Native row press did not open its sheet')
        click({ x: (opened.close.left + opened.close.right) / 2, y: (opened.close.top + opened.close.bottom) / 2 })
        await evaluate('new Promise(resolve => setTimeout(resolve, 500))')
      }
      fs.writeFileSync(path.join(data, width + '-' + height + '.png'), (await win.webContents.capturePage()).toPNG())
      await dispose()
    }
    await load(750, 342, { phone: true, rows: false })
    report.graph = await evaluate('computersGeometry.graphMode()')
    await dispose()
    report.visible = win.isVisible()
  } finally {
    if (win && !win.isDestroyed()) {
      try { await evaluate('computersGeometry.dispose()') } finally { win.destroy() }
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
