'use strict'
// Lane W T20: does Unqueue give the person their words back? Two cases per
// surface -- an empty box, and a box that already holds a draft of its own.
// Hidden sandboxed Electron, native keys and pointer, no provider.
const { app, BrowserWindow, session } = require('electron'), fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || fs.realpathSync.native(data) !== data) throw Error('Owned real output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const p = path.join(data, key); fs.mkdirSync(p, { recursive: true }); app.setPath(key, p) }
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
  const key = (k, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers })
    if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers })
  }
  const type = text => { for (const c of text) key(c) }
  const click = info => {
    if (!info || !info.rect || info.rect.width === 0) throw Error('Missing pointer target: ' + JSON.stringify(info))
    const { x, y, width, height } = info.rect
    for (const t of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type: t, button: 'left', clickCount: 1, x: Math.round(x + width / 2), y: Math.round(y + height / 2) })
  }
  const QUEUED = 'words I typed while it was busy'
  const DRAFT = 'a different draft already in the box'
  for (const mode of ['conversation', 'rail']) {
    const current = { mode, cases: {} }
    report.surfaces.push(current)
    const open = async () => {
      await win.loadFile(path.join(data, 'index.html'))
      await js(`t20.setup(${JSON.stringify(mode)})`)
      if (mode === 'rail') { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }) } else key('Enter')
      await js('t20.ready()')
      await js('t20.startTurn()')
    }

    // CASE A -- the ordinary one: the box is empty, because queueing cleared it.
    await open()
    await js('t20.focusComposer()'); type(QUEUED); key('Enter'); await pause(300)
    const queued = await js('t20.read()')
    if (queued.rows.length !== 1) throw Error('case A did not queue: ' + JSON.stringify(queued.rows))
    click(queued.rows[0].unqueue); await pause(400)
    current.cases.emptyBox = { queuedText: queued.rows[0].text, after: await js('t20.read()') }
    fs.writeFileSync(path.join(data, `${mode}-unqueue-empty-box.png`), (await win.webContents.capturePage()).toPNG())
    save()

    // Up-arrow recall must still work on what is left: queue two, unqueue one,
    // then walk. The walk should reach the survivor, unchanged by this fix.
    await js('t20.setComposer("")')
    await js('t20.focusComposer()'); type('survivor one'); key('Enter'); await pause(250)
    await js('t20.focusComposer()'); type('survivor two'); key('Enter'); await pause(250)
    let s = await js('t20.read()')
    click(s.rows[1].unqueue); await pause(350)
    await js('t20.setComposer("")')
    await js('t20.focusComposer()'); key('Up'); await pause(250)
    current.cases.recallAfterUnqueue = { rows: (await js('t20.read()')).rows.map(r => r.text), box: (await js('t20.read()')).value }
    save()
    await js('t20.dispose()')

    // CASE B -- the box already holds a draft of the person's own.
    await open()
    await js('t20.focusComposer()'); type(QUEUED); key('Enter'); await pause(300)
    await js('t20.focusComposer()'); type(DRAFT)
    const before = await js('t20.read()')
    if (before.rows.length !== 1) throw Error('case B did not queue: ' + JSON.stringify(before.rows))
    click(before.rows[0].unqueue); await pause(400)
    current.cases.draftInBox = { queuedText: before.rows[0].text, draft: DRAFT, after: await js('t20.read()') }
    fs.writeFileSync(path.join(data, `${mode}-unqueue-draft-in-box.png`), (await win.webContents.capturePage()).toPNG())
    save()
    await js('t20.dispose()')
  }
  report.expected = { queued: QUEUED, draft: DRAFT }
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed(); save(); app.exit(0)
}).catch(error => { report.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) win.destroy(); save(); app.exit(1) })
