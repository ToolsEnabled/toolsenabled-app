'use strict'
// Lane W fix (B): does a live stream stay in view for a reader who is at the
// bottom, and does it leave alone a reader who scrolled up on purpose?
// Scrolling away is a NATIVE mouse wheel, not a scrollTop write.
const { app, BrowserWindow, session } = require('electron'), fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url')
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
  win = new BrowserWindow({ show: false, width: 1600, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', d => { if (d.level === 'error') report.pageErrors.push(d.message) })
  const js = code => win.webContents.executeJavaScript(code, true)
  const pause = ms => new Promise(r => setTimeout(r, ms))
  // A real wheel gesture over the transcript, the way a person scrolls up.
  const wheelUp = async (rect, notches) => {
    for (let i = 0; i < notches; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), deltaX: 0, deltaY: 120, canScroll: true })
      await pause(30)
    }
    await pause(200)
  }
  for (const mode of ['conversation', 'rail']) {
    const current = { mode, stages: [] }
    report.surfaces.push(current)
    const snapshot = async name => { const state = await js('fix.read()'); current.stages.push({ name, state }); save(); return state }
    const capture = async name => fs.writeFileSync(path.join(data, `${mode}-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await win.loadFile(path.join(data, 'index.html'))
    current.setup = await js(`fix.setup(${JSON.stringify(mode)})`)
    if (mode === 'rail') { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }) } else { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }) }
    await js('fix.ready()')
    await js('fix.seed(14)')
    await snapshot('seeded')

    // CASE 1 -- the reader is at the bottom. A stream must follow.
    await js('fix.read()')
    await snapshot('at-bottom-before-stream')
    await js('fix.startStream()')
    await snapshot('at-bottom-stream-started')
    await js('fix.beginReply()')
    await snapshot('at-bottom-reply-fragment')
    await js('fix.grow(6)')
    await snapshot('at-bottom-stream-grown')
    await capture('at-bottom-stream-grown')

    // CASE 2 -- the reader scrolls up on purpose with a real wheel. The stream
    // must NOT drag them back, and the pill must offer the way down.
    const rect = await js('fix.logRect()')
    current.logRect = rect
    await wheelUp(rect, 8)
    const parked = await snapshot('scrolled-up-parked')
    current.grewWhileParked = (await js('fix.grow(6)')).grewBy
    const held = await snapshot('scrolled-up-after-growth')
    current.heldStill = Math.abs((held.log?.scrollTop ?? -1) - (parked.log?.scrollTop ?? -2)) <= 2
    await capture('scrolled-up-after-growth')
    await js('fix.dispose()')

    // CASE 3 -- the entry path W3 observed: open the conversation onto an
    // existing transcript and have the stream arrive at once, with no settling
    // in between. This is the shape a returning reader actually meets.
    await win.loadFile(path.join(data, 'index.html'))
    await js(`fix.setup(${JSON.stringify(mode)})`)
    if (mode === 'rail') { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }) } else { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }) }
    await js('fix.ready()')
    await js('fix.seedAndStream(14)')
    await snapshot('fresh-open-stream')
    await js('fix.grow(4)')
    await snapshot('fresh-open-stream-grown')
    await capture('fresh-open-stream-grown')
    await js('fix.dispose()')
  }
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed(); save(); app.exit(0)
}).catch(error => { report.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) win.destroy(); save(); app.exit(1) })
