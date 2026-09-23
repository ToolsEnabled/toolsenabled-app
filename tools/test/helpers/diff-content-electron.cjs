'use strict'
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
process.on('uncaughtException',error=>{console.error(error.stack);app.exit(1)})
const { fileURLToPath } = require('node:url')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || fs.realpathSync.native(data) !== data) throw Error('Real isolated output required')
app.setName('ToolsEnabled isolated diff content')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(data, key)
  if(!fs.existsSync(directory))fs.mkdirSync(directory)
  assert(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink())
  assert.equal(fs.realpathSync.native(directory),directory)
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()
const report = { rows: [], pageErrors: [], deniedRequests: [] }
assert.equal(app.commandLine.getSwitchValue('user-data-dir'),path.join(data,'userData'))
if(process.platform==='win32') {
  const identity=JSON.parse(execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`],
    {windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,PSModulePath:''}}))
  assert.equal(identity.ProcessId,process.pid);assert(identity.CreationDate)
  assert(identity.CommandLine.includes('--user-data-dir='+path.join(data,'userData')))
  report.identity={pid:identity.ProcessId,creationDate:identity.CreationDate,userData:path.join(data,'userData')}
}
let win
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('data:') || details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data
    if (!allowed) report.deniedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  win = new BrowserWindow({ show: false, width: 1120, height: 1000, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message) })
  await win.loadFile(path.join(data, 'index.html'))
  await win.webContents.executeJavaScript('diffContentFixture.open()', true)
  for (const width of [1120, 600]) {
    win.setContentSize(width, 1000)
    report.rows.push({ width, ...await win.webContents.executeJavaScript('diffContentFixture.measure()', true) })
    fs.writeFileSync(path.join(data, `diff-${width}.png`), (await win.webContents.capturePage()).toPNG())
  }
  report.longContext = await win.webContents.executeJavaScript('diffContentFixture.longContext()', true)
  report.unavailable = await win.webContents.executeJavaScript('diffContentFixture.unavailable()', true)
  await win.webContents.executeJavaScript('diffContentFixture.close()', true)
  report.visible = win.isVisible(); win.destroy(); report.destroyed = win.isDestroyed()
  save(); app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }; save()
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(1)
})
