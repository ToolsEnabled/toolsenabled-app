'use strict'
// Lane W fix (C): Boxes at Large, Medium and Mini, hidden sandboxed Electron.
const { app, BrowserWindow, session } = require('electron'), fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || fs.realpathSync.native(data) !== data) throw Error('Owned real output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const p = path.join(data, key); fs.mkdirSync(p); app.setPath(key, p) }
app.disableHardwareAcceleration()
let win
const report = { sizes: {}, pageErrors: [], deniedRequests: [] }
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2))
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const allow = d.url.startsWith('data:') || (d.url.startsWith('file:') && path.dirname(fileURLToPath(d.url)) === data)
    if (!allow) report.deniedRequests.push(d.url)
    cb({ cancel: !allow })
  })
  win = new BrowserWindow({ show: false, width: 1440, height: 920, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', d => { if (d.level === 'error') report.pageErrors.push(d.message) })
  const js = code => win.webContents.executeJavaScript(code, true)
  await win.loadFile(path.join(data, 'index.html'))
  for (const size of ['large', 'medium', 'mini']) {
    report.sizes[size] = await js(`cards.mount(${JSON.stringify(size)}, 'boxes')`)
    save()
    fs.writeFileSync(path.join(data, `boxes-${size}.png`), (await win.webContents.capturePage()).toPNG())
    await js('cards.dispose()')
  }
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed(); save(); app.exit(0)
}).catch(error => { report.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) win.destroy(); save(); app.exit(1) })
