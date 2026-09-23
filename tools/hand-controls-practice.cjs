'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const data = process.argv[2]
const check = process.argv.includes('--check')
const benchmark = process.argv.includes('--benchmark')
const benchmarkFrames = process.argv.includes('--sustained') ? 400 : 80
if (!data || !path.isAbsolute(data) || (process.platform === 'win32'
  && !data.toLowerCase().startsWith('c:\\users\\toolsenabled-dev\\appdata\\local\\temp\\'))) throw Error('Practice requires an explicit Dev temp profile')
const profileComponents = []
for (let cursor = path.resolve(data); ; cursor = path.dirname(cursor)) {
  profileComponents.unshift(cursor)
  if (cursor === path.dirname(cursor) || (process.platform === 'win32' && cursor.toLowerCase() === 'c:\\users\\toolsenabled-dev')) break
}
for (const cursor of profileComponents) {
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Practice profile contains a link')
}
app.setPath('userData', data)
if (check) app.commandLine.appendSwitch('use-fake-device-for-media-stream')
let win, cameraAllowed = false
const servedSources = new Set(['hand-controls.js', 'hand-pointer.js', 'hand-press.js', 'hand-control-settings.js', 'product-settings-layout.js', 'hand-controls.css', 'accessibility-controls.css'])
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  let file
  if (pathname === '/') file = path.join(__dirname, 'hand-controls-practice.html')
  else if (pathname.startsWith('/src/') && servedSources.has(pathname.slice(5))) file = path.join(root, 'src', pathname.slice(5))
  else if (/^\/hand-controls\/(tracker\.js|NOTICE\.txt|vendor\/(vision_bundle\.js|vision_wasm_internal\.(js|wasm)|hand_landmarker\.task|LICENSE\.txt))$/.test(pathname)) file = path.join(root, 'public', pathname)
  else if (benchmark && pathname === '/fixture.jpg') file = path.join(data, 'thumb_up.jpg')
  if (!file) { response.writeHead(404); response.end(); return }
  const type = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.jpg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream'
  response.setHeader('Content-Type', type)
  fs.createReadStream(file).on('error', () => { response.writeHead(404); response.end() }).pipe(response)
})
async function main() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  win = new BrowserWindow({ show: !check && !benchmark, width: 1100, height: 850,
    title: 'ToolsEnabled · Hand controls practice', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'hand-controls-practice-preload.cjs'), contextIsolation: true, nodeIntegration: false } })
  ipcMain.handle('hand-practice:enabled', (event, enabled) => {
    if (event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame
      || new URL(event.senderFrame.url).origin !== origin || typeof enabled !== 'boolean') throw Error('Untrusted camera request')
    cameraAllowed = enabled && (check || win.isFocused())
    return { enabled: cameraAllowed }
  })
  require('../shell/voice-permissions.cjs').installVoicePermissions(win.webContents.session, {
    owns: contents => contents === win.webContents,
    allows: () => false,
    allowsCamera: () => cameraAllowed && (check || win.isFocused()),
  })
  win.on('blur', () => { cameraAllowed = false })
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => { cameraAllowed = false; server.close(); app.quit() })
  await win.loadURL(origin)
  if (check) {
    const runRendererChecks = require('./test/helpers/hand-controls-renderer-checks.cjs')
    console.log(JSON.stringify({ ok: true, checks: await runRendererChecks(win) }))
  } else if (benchmark) {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src='/fixture.jpg'; await image.decode();
      const worker = new Worker('/hand-controls/tracker.js');
      const wait = () => new Promise((resolve,reject) => {
        const timer=setTimeout(()=>reject(Error('Tracker timed out')),25000);
        worker.onmessage=({data})=>{clearTimeout(timer);data.type==='error'?reject(Error(data.message)):resolve(data)};
        worker.onerror=error=>{clearTimeout(timer);reject(Error(error.message))};
      });
      const initializing=wait(); worker.postMessage({type:'init'}); const ready=await initializing;
      const samples=[]; let detected=0;
      for(let i=0;i<${benchmarkFrames};i++) {
        const frame=await createImageBitmap(image), pending=wait();
        worker.postMessage({type:'frame',frame,at:performance.now()},[frame]);
        const value=await pending;if(value.landmarks?.length===21)detected++;
        if(i>=10)samples.push(value.ms);
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      worker.terminate();samples.sort((a,b)=>a-b);
      return {fixture:'thumb_up.jpg',renderer:ready.renderer,frames:${benchmarkFrames},detected,warmSamples:samples.length,
        medianMs:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)]};
    })()`)
    assert.equal(result.detected, result.frames, 'The real model must detect the fixture hand')
    console.log(JSON.stringify({ ok: true, benchmark: result, gpuFeatures: app.getGPUFeatureStatus(), processes: app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage, memory: p.memory })) }))
  } else console.log(JSON.stringify({ ready: true, practice: true, pid: process.pid }))
  if (check || benchmark) { win.destroy(); server.close(); app.exit(0) }
}
main().catch(error => { console.error(error); win?.destroy(); server.close(); app.exit(1) })
