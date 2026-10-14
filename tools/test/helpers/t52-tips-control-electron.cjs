'use strict'

/* T52(4). The "Turn off new-page tips" control, on every route that offers a
   guide, read from a real rendered window. Builder (4a1a39df) measured it 0x0
   on Ledger and Settings and 121x44 on Metrics on the cut-1 candidate; this
   asks the same question under conditions the fixture controls, so the answer
   separates "the page collapses it" from "it was measured in a different
   state". */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) {
  throw Error('Real isolated output required')
}
app.setName('ToolsEnabled isolated tips control')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()

const report = { rows: [], presses: [], pageErrors: [], deniedRequests: [] }
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
    show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => {
    if (details.level === 'error') report.pageErrors.push(details.message)
  })
  await win.loadFile(path.join(data, 'index.html'))
  const js = code => win.webContents.executeJavaScript(code, true)

  report.routes = await js('t52Tips.routes()')

  /* EVERY ROUTE THAT OFFERS A GUIDE, at the intro -- which is the state a
     person meets when the card opens itself on a page they have not seen. */
  for (const route of report.routes) {
    report.rows.push(await js(`t52Tips.open(${JSON.stringify(route)})`))
    save()
    report.presses.push({ route, ...(await js('t52Tips.press()')) })
    save()
  }

  /* AND PAST THE INTRO, on the same routes. paint() sets the control's own
     `hidden` from `step < 0`, so this is the state that can legitimately
     produce a zero box -- recorded so the two are never confused again. */
  for (const route of report.routes) {
    report.rows.push(await js(`t52Tips.open(${JSON.stringify(route)}, { advance: 1 })`))
    save()
  }

  /* And the two states the guide itself calls blocked. */
  for (const blockWith of ['modal', 'first-run']) {
    report.rows.push({ blockWith, ...(await js(`t52Tips.open("ledger", { blockWith: ${JSON.stringify(blockWith)} })`)) })
    save()
  }

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
