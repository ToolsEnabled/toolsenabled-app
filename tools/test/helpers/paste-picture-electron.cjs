'use strict'
/* T18 native scenario, main process half. Hidden window, own user-data-dir,
   real key events. Adapted from computers-composer-electron.cjs. */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || fs.realpathSync.native(data) !== data) throw Error('Owned real output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const p = path.join(data, key); fs.mkdirSync(p); app.setPath(key, p) }
app.disableHardwareAcceleration()

let win
const report = { surfaces: [], pageErrors: [], deniedRequests: [] }
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2))
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const allow = d.url.startsWith('data:') || (d.url.startsWith('file:') && path.dirname(fileURLToPath(d.url)) === data)
    if (!allow) report.deniedRequests.push(d.url)
    cb({ cancel: !allow })
  })
  win = new BrowserWindow({ show: false, width: 2560, height: 1040, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', d => { if (d.level === 'error') report.pageErrors.push(d.message) })
  const js = code => win.webContents.executeJavaScript(code, true)
  const key = k => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k })
    if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k })
  }
  const png = fs.readFileSync(path.join(data, 'fixture.png')).toString('base64')
  const receiptFile = path.join(data, 'picture-not-sent.json')
  const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null
  /* The code the stand-in host will REJECT the send with, when the caller asked
     for one. Absent file, absent refusal, unchanged run. */
  const refusalFile = path.join(data, 'send-refusal.json')
  const refusal = fs.existsSync(refusalFile) ? JSON.parse(fs.readFileSync(refusalFile, 'utf8')).code : null

  /* BOTH SURFACES THE OWNER USES: the full tree conversation and the right
     rail. A picture that works in one and not the other is still the defect. */
  for (const mode of ['conversation', 'rail']) {
    const current = { mode, steps: [] }
    report.surfaces.push(current)
    await win.loadFile(path.join(data, 'index.html'))
    /* The receipt the stand-in host will answer this surface's send with, when
       the caller asked for one. Absent file, absent receipt, unchanged run. */
    if (receipt) current.receiptArmed = await js(`pastePicture.setPictureNotSent(${JSON.stringify(receipt)})`)
    if (refusal) current.refusalArmed = await js(`pastePicture.setSendRefusal(${JSON.stringify(refusal)})`)
    current.setup = await js(`pastePicture.setup(${JSON.stringify(mode)}, ${JSON.stringify(png)})`)
    /* Open the conversation the same way a person does: Enter on the focused
       node for the full conversation, Shift+Enter for the rail. */
    if (mode === 'rail') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] })
    } else key('Enter')
    current.ready = await js('pastePicture.ready()')
    current.idle = await js('pastePicture.idle()')
    await js('pastePicture.focusComposer()')
    current.pasted = await js('pastePicture.paste()')
    save()
    fs.writeFileSync(path.join(data, mode + '-after-paste.png'), (await win.webContents.capturePage()).toPNG())
    current.typed = await js(`pastePicture.type(${JSON.stringify('what is in this picture?')})`)
    /* THE SEND IS A REAL KEYSTROKE, not a call into the view. */
    key('Enter')
    current.result = await js('pastePicture.afterSend()')
    save()
    fs.writeFileSync(path.join(data, mode + '-after-send.png'), (await win.webContents.capturePage()).toPNG())
    await js('pastePicture.dispose()')
  }
  report.visible = win.isVisible()
  win.destroy()
  report.destroyed = win.isDestroyed()
  save()
  app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }
  if (win && !win.isDestroyed()) win.destroy()
  save()
  app.exit(1)
})
