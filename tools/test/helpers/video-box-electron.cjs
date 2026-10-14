'use strict'
/* 1.0.49 VIDEO BOX IN A REAL ELECTRON: the capture permission gate (review F1).
 *
 * Runs inside a private X server started by tools/test/video-box-electron.test.mjs
 * (never the person's desktop: a capture here would read their screen). It wires
 * the app's REAL shell/video-box-host.cjs and shell/voice-permissions.cjs the way
 * shell/main.cjs does, opens one xterm as the window to pick, and prints one JSON
 * line with what happened.
 *
 * What it proves, each measured rather than assumed:
 *   - page script cannot list windows without the person's click;
 *   - the old desktop getUserMedia, which asks the same permission question as
 *     getDisplayMedia but never reaches the display handler, gets at most one
 *     capture per pick, and the page is reloaded GRANT_CHECK_MS later, which
 *     ends it;
 *   - the intended path (a click, a pick, getDisplayMedia) still works, twice in
 *     a row, because Electron asks the permission gate afresh for each request;
 *   - one pick is one stream: a second getDisplayMedia on it is refused.
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, webContents } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { createVideoBoxHost, GRANT_CHECK_MS } = require('../../../shell/video-box-host.cjs')
const { installVoicePermissions } = require('../../../shell/voice-permissions.cjs')

const dataRoot = process.argv[2]
if (!dataRoot || !path.isAbsolute(dataRoot)) throw new Error('An isolated user-data directory is required.')
app.setPath('userData', dataRoot)
app.commandLine.appendSwitch('disable-gpu')

const SOURCE = 'VIDEO-BOX-SOURCE'
const APP_TITLE = 'VIDEO-BOX-APP'
const steps = {}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const PAGE = `<!doctype html><meta charset="utf-8"><title>${APP_TITLE}</title><body>
<script>
window.streams = []
async function capture(ask) {
  try {
    const stream = await ask()
    window.streams.push(stream)
    const track = stream.getVideoTracks()[0]
    return { ok: true, label: track ? track.label : '', state: track ? track.readyState : '' }
  } catch (error) { return { ok: false, name: error.name } }
}
const legacy = () => navigator.mediaDevices.getUserMedia({ audio: false,
  video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 1280, maxHeight: 720 } } })
const display = () => navigator.mediaDevices.getDisplayMedia({
  video: { width: { max: 854 }, height: { max: 480 }, frameRate: { max: 10 } }, audio: false })
async function pick(name) {
  const listed = await window.mcVideoBox.sources()
  if (!listed.ok) return { ok: false, code: listed.code }
  const source = listed.sources.find(row => row.name === name)
  if (!source) return { ok: false, code: 'NOT_LISTED' }
  const armed = await window.mcVideoBox.arm({ token: source.token, nodeId: 'node-1' })
  return armed.ok ? { ok: true } : { ok: false, code: armed.code }
}
window.probe = {
  list: async () => { const listed = await window.mcVideoBox.sources(); return listed.ok ? { ok: true, names: listed.sources.map(row => row.name) } : { ok: false, code: listed.code } },
  legacyTwice: async name => { const armed = await pick(name); if (!armed.ok) return { armed }; return { armed, first: await capture(legacy), second: await capture(legacy) } },
  displayOnce: async name => { const armed = await pick(name); if (!armed.ok) return { armed }; return { armed, first: await capture(display) } },
  displayTwice: async name => { const armed = await pick(name); if (!armed.ok) return { armed }; return { armed, first: await capture(display), second: await capture(display) } },
  live: () => window.streams.map(stream => stream.getVideoTracks()[0]?.readyState || ''),
}
</script>`

// Threads in this (the browser) process whose name says they capture the desktop.
function captureThreads() {
  try {
    return fs.readdirSync('/proc/self/task').filter(id => {
      try { return /capture/i.test(fs.readFileSync(`/proc/self/task/${id}/comm`, 'utf8')) } catch { return false }
    }).length
  } catch { return -1 }
}

// A window manager marks each top-level window with WM_STATE; there is none here.
function showSource() {
  const child = spawn('xterm', ['-T', SOURCE, '-geometry', '40x8+700+40', '-e', 'sleep', '120'], { stdio: 'ignore' })
  return child
}
async function markSourceNormal() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const tree = execFileSync('xwininfo', ['-root', '-children'], { encoding: 'utf8' })
    const line = tree.split('\n').find(row => row.includes(`"${SOURCE}"`))
    const id = line?.trim().split(/\s+/)[0]
    if (id) { execFileSync('xprop', ['-id', id, '-f', 'WM_STATE', '32cc', '-set', 'WM_STATE', '1, 0']); return true }
    await wait(100)
  }
  return false
}

async function run() {
  await app.whenReady()
  const source = showSource()
  try {
    steps.sourceShown = await markSourceNormal()
    const server = http.createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGE) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const window = new BrowserWindow({ x: 20, y: 20, width: 640, height: 400, show: true, title: APP_TITLE,
      webPreferences: { preload: path.join(__dirname, 'video-box-electron-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const owner = window.webContents
    const reloads = []
    let navigations = 0
    // The same host and gates shell/main.cjs builds, with main's own endStrayCapture.
    const host = createVideoBoxHost({ desktopCapturer, BrowserWindow, webContents, shellOrigin: () => origin, supported: () => true,
      store: { remember: record => ({ ...record, savedAt: new Date().toISOString() }), forget() {}, clear() {}, list: () => [] },
      readIdentity: () => nodeId => ({ treeId: 'tree-1', nodeId, nodeCreatedAt: '1' }),
      endStrayCapture: contents => { reloads.push(Date.now()); if (!contents.isDestroyed()) contents.reload() } })
    // Timed only: how long after the permission grant Electron calls the display handler.
    let grantedAt = null
    const gaps = []
    installVoicePermissions(owner.session, { owns: contents => contents === owner, allows: () => false, allowsCamera: () => false,
      allowsDisplayCapture: contents => { const answer = host.allowsDisplayCapture(contents); if (answer) grantedAt = performance.now(); return answer } })
    const handler = host.displayHandler(owner)
    owner.session.setDisplayMediaRequestHandler((request, callback) => {
      if (grantedAt !== null) gaps.push(Math.round((performance.now() - grantedAt) * 10) / 10)
      grantedAt = null
      handler(request, callback)
    })
    steps.grantToDisplayHandlerMs = gaps
    owner.on('did-start-navigation', details => {
      if (!details || details.isMainFrame !== true || details.isSameDocument === true) return
      navigations++
      host.close(owner)
    })
    const trusted = event => event.sender === owner && event.senderFrame === owner.mainFrame
    ipcMain.handle('mc-video-box:sources', event => trusted(event) ? host.sources(event.sender) : { ok: false, code: 'UNTRUSTED' })
    ipcMain.handle('mc-video-box:arm', (event, value) => trusted(event) ? host.arm(event.sender, value) : { ok: false, code: 'UNTRUSTED' })
    ipcMain.handle('mc-video-box:forget', (event, value) => trusted(event) ? host.forget(event.sender, value) : { ok: false, code: 'UNTRUSTED' })
    await window.loadURL(origin + '/')
    const page = (code, gesture) => owner.executeJavaScript(code, gesture)
    const loaded = () => new Promise(resolve => owner.once('did-finish-load', resolve))

    steps.baselineThreads = captureThreads()
    steps.listWithoutClick = await page('probe.list()', false)
    steps.listWithClick = await page('probe.list()', true)

    // The old desktop getUserMedia through the same gate, then the reload that ends it.
    await page('window.mark = "before"', false)
    const reloaded = loaded()
    const before = navigations
    const armedAt = Date.now()
    steps.legacy = await page(`probe.legacyTwice(${JSON.stringify(SOURCE)})`, true)
    steps.legacyThreadsWhileLive = captureThreads()
    await Promise.race([reloaded, wait(GRANT_CHECK_MS + 6000)])
    steps.strayReloads = reloads.length
    steps.strayReloadAfterMs = reloads.length ? reloads[0] - armedAt : null
    steps.navigatedAfterLegacy = navigations - before
    steps.markAfterLegacy = await page('String(window.mark)', false)
    await wait(1000)
    steps.threadsAfterReload = captureThreads()

    // The intended path, twice, and nothing reloads.
    await page('window.mark = "intended"', false)
    const navigationsBefore = navigations
    steps.displayFirst = await page(`probe.displayOnce(${JSON.stringify(SOURCE)})`, true)
    steps.displaySecond = await page(`probe.displayOnce(${JSON.stringify(SOURCE)})`, true)
    await wait(GRANT_CHECK_MS + 1500)
    steps.intendedReloads = reloads.length - steps.strayReloads
    steps.navigatedAfterIntended = navigations - navigationsBefore
    steps.markAfterIntended = await page('String(window.mark)', false)
    steps.liveAfterIntended = await page('probe.live()', false)

    // One pick, one stream.
    steps.onePickTwoRequests = await page(`probe.displayTwice(${JSON.stringify(SOURCE)})`, true)
    await wait(GRANT_CHECK_MS + 1500)
    steps.reloadsAtEnd = reloads.length
    await page('window.streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); 0', false)
    server.close()
  } finally {
    try { process.kill(source.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  process.stdout.write(JSON.stringify({ done: true, steps }) + '\n')
}

run().then(() => app.exit(0), error => {
  process.stdout.write(JSON.stringify({ done: false, error: String(error?.stack || error), steps }) + '\n')
  app.exit(1)
})
