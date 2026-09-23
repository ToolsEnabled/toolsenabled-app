'use strict'

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) {
  throw Error('Real isolated output required')
}

app.setName('ToolsEnabled T1033 retry layout')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()

const WIDTHS = [320, 768, 1280]
const STATES = ['normal', 'waiting', 'refusal']
const inertAttachmentPath = path.join(data, 'retained', 't1033-inert-attachment.png')
const TAB_LIMIT = 12
const report = {
  rows: [],
  pageErrors: [],
  deniedRequests: [],
  providerCalls: 0,
  windowsCreated: 0,
  tabLimit: TAB_LIMIT,
  profile: path.join(data, 'userData'),
}
let win
let closeStarted = false

const save = () => {
  fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const key = async (keyCode, modifiers = []) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // A physical Enter also produces its character event; Chromium activates a
  // focused button from that event, not from keyDown alone.
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await delay(35)
}
const tabToRetry = async () => {
  for (let step = 1; step <= TAB_LIMIT; step += 1) {
    await key('Tab')
    const active = await win.webContents.executeJavaScript('t844RetryLayout.activeElementName()', true)
    if (active === 'account-retry') return step
  }
  return null
}
const activateRetryNow = async () => {
  await key('Tab')
  const active = await win.webContents.executeJavaScript('t844RetryLayout.activeElementName()', true)
  if (active !== 'account-retry-now') return false
  await key('Enter')
  return true
}
const tabBackToRetry = async () => {
  await key('Tab', ['shift'])
  const active = await win.webContents.executeJavaScript('t844RetryLayout.activeElementName()', true)
  return active === 'account-retry'
}
const providerPattern = /(api\.openai|anthropic|googleapis|generativelanguage|xai\.api|provider|oauth|claude|codex)/i
const captureRow = async (width, state) => {
  const relative = 'screenshots/' + width + '-' + state + '.png'
  fs.mkdirSync(path.join(data, 'screenshots'), { recursive: true })
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(data, 'screenshots', width + '-' + state + '.png'), image.toPNG())
  return relative
}
const focusContent = async () => {
  win.webContents.focus()
  return {
    requested: true,
    webContentsFocused: win.webContents.isFocused(),
    documentHasFocus: await win.webContents.executeJavaScript('document.hasFocus()', true),
  }
}

const closeWindow = async () => {
  if (closeStarted) return
  closeStarted = true
  if (!win || win.isDestroyed()) return
  win.close()
  await delay(20)
  if (!win.isDestroyed()) win.destroy()
}

app.on('browser-window-created', () => { report.windowsCreated += 1 })
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let localFile = null
    try {
      if (details.url.startsWith('file:')) localFile = fileURLToPath(details.url)
    } catch {}
    const allowed = details.url.startsWith('data:')
      || (localFile && (localFile === data || localFile.startsWith(data + path.sep)))
    if (!allowed) {
      report.deniedRequests.push(details.url)
      if (providerPattern.test(details.url)) report.providerCalls += 1
    }
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  })
  win.setPosition(-32000, -32000)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => {
    if (details.level === 'error') report.pageErrors.push(details.message)
  })
  await win.loadFile(path.join(data, 'index.html'))
  await win.webContents.executeJavaScript('t844RetryLayout.ready()', true)

  for (const width of WIDTHS) {
    win.setContentSize(width, 900)
    await delay(60)
    for (const state of STATES) {
      const initial = await win.webContents.executeJavaScript(
        't844RetryLayout.mount(' + JSON.stringify(width) + ',' + JSON.stringify(state)
          + ',' + JSON.stringify(inertAttachmentPath) + ')', true)
      const contentFocus = await focusContent()
      const focusedDraft = await win.webContents.executeJavaScript('t844RetryLayout.focusDraft()', true)
      const target = state === 'normal' ? 'wait' : state === 'waiting' ? 'off' : null
      const tabSteps = target ? await tabToRetry() : null
      const tabbedToRetry = tabSteps !== null
      let tabbedBackToRetry = false
      let retryNowTriggered = false
      if (target === 'wait' && tabbedToRetry) {
        await key('Down')
      } else if (target === 'off' && tabbedToRetry) {
        retryNowTriggered = await activateRetryNow()
        if (retryNowTriggered) {
          tabbedBackToRetry = await tabBackToRetry()
          if (tabbedBackToRetry) await key('Home')
        }
      }
      const after = await win.webContents.executeJavaScript('t844RetryLayout.measure()', true)
      const screenshot = await captureRow(width, state)
      const send = await win.webContents.executeJavaScript('t844RetryLayout.sendInert()', true)
      report.rows.push({
        requestedWidth: width,
        state,
        target,
        focusedDraft,
        contentFocus,
        tabbedToRetry,
        tabSteps,
        tabbedBackToRetry,
        retryNowTriggered,
        screenshot,
        send,
        initial,
        after,
      })
      save()
    }
  }

  report.visible = win.isVisible()
  report.offscreen = typeof win.webContents.isOffscreen === 'function'
    ? win.webContents.isOffscreen()
    : true
  report.boundsBeforeClose = win.getBounds()
  await closeWindow()
  report.closed = !win || win.isDestroyed()
  report.destroyed = !win || win.isDestroyed()
  save()
  app.exit(0)
}).catch(async error => {
  report.failure = { message: error.message, stack: error.stack }
  await closeWindow().catch(() => {})
  save()
  app.exit(1)
})
