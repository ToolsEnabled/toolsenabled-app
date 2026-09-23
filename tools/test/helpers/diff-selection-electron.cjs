'use strict'
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { fileURLToPath } = require('node:url')
const { createDiffFiles } = require('../../../shell/diff-file.cjs')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw Error('Real isolated output required')
app.setName('ToolsEnabled isolated diff selection')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key); fs.mkdirSync(directory); app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const workspace = path.join(data, 'workspace'); fs.mkdirSync(workspace)
const first = path.join(workspace, 'first.txt'), selected = path.join(workspace, 'selected.txt')
fs.writeFileSync(first, 'other file\n'); fs.writeFileSync(selected, 'after\n')
const files = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [workspace] })
const report = { pageErrors: [], deniedRequests: [], readRequests: [], pickCount: 0 }
let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { preload: path.join(__dirname, 'diff-selection-preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message) })
  const own = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  ipcMain.handle('fixture:inputs', event => { if (!own(event)) throw Error('Fixture sender required'); return { first, selected } })
  ipcMain.handle('fixture:read-change', (event, request) => {
    if (!own(event)) throw Error('Fixture sender required')
    report.readRequests.push(path.basename(request.path))
    return files.readChange(request.path)
  })
  ipcMain.handle('fixture:pick', () => { report.pickCount++; throw Error('Unexpected picker') })
  await win.loadFile(path.join(data, 'index.html'))
  report.selection = await win.webContents.executeJavaScript('diffSelectionFixture()', true)
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed()
  save(); app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }; save()
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(1)
})
