// Run explicitly with a new output directory; no LIVE state or provider calls.
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const out=path.resolve(process.argv[2]||'')
const allowed='C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp'
if(!process.argv[2] || !path.isAbsolute(process.argv[2]) || !out.toLowerCase().startsWith(allowed.toLowerCase()+path.sep)) throw Error('Supply a literal ToolsEnabled-Dev Temp subfolder')
// Refuse links before creating anything beneath a caller-supplied path.
for(let part=out;part.toLowerCase().startsWith(allowed.toLowerCase());part=path.dirname(part)){
  if(existsSync(part) && lstatSync(part).isSymbolicLink())throw Error('Output path must not traverse a link')
  if(part.toLowerCase()===allowed.toLowerCase())break
}
mkdirSync(out,{recursive:true})
if(!realpathSync(out).toLowerCase().startsWith(allowed.toLowerCase()+path.sep)) throw Error('Resolved output is outside allowed Temp')
const here=path.dirname(fileURLToPath(import.meta.url))
const root=path.resolve(here,'../../..')
const server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0,fs:{allow:[root,path.resolve(root,'../deps/app-node_modules')]}},logLevel:'error'})
let child, socket
try{
  await server.listen()
  const port=server.httpServer.address().port
  const origin=`http://127.0.0.1:${port}`
  const profile=mkdtempSync(path.join(out,'browser-'))
  const devRoot='C:\\Users\\ToolsEnabled-Dev'
  const env={...process.env,TEMP:allowed,TMP:allowed,USERPROFILE:devRoot,APPDATA:devRoot+'\\AppData\\Roaming',LOCALAPPDATA:devRoot+'\\AppData\\Local'}
  delete env.ELECTRON_RUN_AS_NODE
  child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--metrics-recording-only','--safebrowsing-disable-auto-update','--password-store=basic','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank',
  ],{cwd:root,windowsHide:true,env,stdio:['ignore','ignore','pipe']})
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  let debugPort
  for(let n=0;n<160;n++){try{debugPort=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await delay(50)}
  if(!debugPort)throw Error('Isolated browser did not become ready')
  const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  let id=0
  const pending=new Map(),errors=[]
  const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(Error(`Timeout: ${method}`))},15000);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}))})
  socket.addEventListener('message',event=>{
    const msg=JSON.parse(event.data)
    if(msg.id){const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result)}
    else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text)
    else if(msg.method==='Fetch.requestPaused'){const allowed=msg.params.request.url.startsWith(origin+'/')||msg.params.request.url.startsWith('data:');void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId:msg.params.requestId,...(allowed?{}:{errorReason:'BlockedByClient'})})}
  })
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Page.bringToFront')
  await send('Emulation.setDeviceMetricsOverride',{width:2048,height:1100,deviceScaleFactor:1,mobile:false})
  await send('Page.navigate',{url:origin+'/tools/test/fixtures/page2-layout.html'})
  for(let n=0;n<160;n++){if(await evaluate('!!window.page2LayoutReady'))break;await delay(50)}
  if(!await evaluate('!!window.page2LayoutReady'))throw Error('Fixture did not load: '+errors.join('\n'))
  const results=[]
  for(const theme of ['white','tan','black'])for(const size of [0.9,1,1.12]){
    const measured=await evaluate(`window.page2Layout.mount(${JSON.stringify({theme,size})})`)
    results.push({theme,size,...measured})
    assert.equal(measured.streamBounds.overlaps.length,0,`${theme}/${size}: streaming answer overlaps work`)
    assert.equal(measured.chat.overlaps.length,0,`${theme}/${size}: settled transcript overlaps`)
    assert.ok(measured.chat.horizontalOverflow<=1,`${theme}/${size}: long content widens the chat`)
    assert.ok(measured.previewHeights.every(h=>h<=196),`${theme}/${size}: preview is unbounded`)
    assert.ok(measured.cards.every(c=>c.h<=196*size+2),`${theme}/${size}: painted preview ignores text size`)
    const shot=await send('Page.captureScreenshot',{format:'png'})
    writeFileSync(path.join(out,`${theme}-${size}.png`),Buffer.from(shot.data,'base64'))
    await evaluate('window.page2Layout.scrollEnd()')
    const endShot=await send('Page.captureScreenshot',{format:'png'})
    writeFileSync(path.join(out,`${theme}-${size}-tools.png`),Buffer.from(endShot.data,'base64'))
  }
  const tools=await evaluate('window.page2Layout.toggleTools()')
  const manualZoom=await evaluate('window.page2Layout.resizeAfterManualZoom()')
  assert.equal(tools.open,true)
  assert.equal(tools.overlaps.length,0)
  assert.equal(await evaluate('window.page2Layout.focusToolSummary()'),true)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  assert.equal(await evaluate('window.page2Layout.toolDisclosureState()'),false,'The tool run must close by keyboard')
  assert.deepEqual(manualZoom.after,manualZoom.before)
  const bodySelection=await evaluate('window.page2Layout.bodySelection()')
  assert.equal(bodySelection.open,true,'Selecting full context must not collapse its disclosure')
  const negativeControl=await evaluate('window.page2Layout.negativeControl()')
  assert.ok(negativeControl>0,'The negative control must detect the original shrink overlap')
  const thousand=await evaluate('window.page2Layout.mount({theme:"black",size:1,count:1000,short:true})')
  assert.equal(thousand.retainedNodes,1000)
  assert.ok(thousand.nodes.length>0)
  assert.ok(Number.isFinite(thousand.renderMs))
  const drill=[]
  for(let step=0;step<8;step++){
    const target=await evaluate('window.page2Layout.nextDrillTarget("node-999")')
    assert.equal(target.refused,undefined,`No drill path to node-999: ${JSON.stringify(target)}`)
    assert.equal(target.hit,true,`Drill node is not hit-testable: ${JSON.stringify(target)}`)
    if(step===0)assert.equal(target.wasCulled,true,'Navigation control must start with an actually culled record')
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1})
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1})
    await delay(1000)
    drill.push({target:target.id,...await evaluate('window.page2Layout.selection()')})
    if(target.id==='node-999')break
  }
  assert.deepEqual(drill.at(-1).lastSelected,{id:'node-999',state:'running'})
  const overview=await evaluate('window.page2Layout.returnOverview()')
  assert.equal(overview.rootId,null)
  assert.equal(overview.modelCount,1000)
  assert.equal(overview.retainedNodes,1000)
  await send('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false})
  const compact=await evaluate('window.page2Layout.mount({theme:"black",size:1.12})')
  assert.equal(compact.chat.overlaps.length,0)
  assert.ok(compact.chat.horizontalOverflow<=1)
  const compactShot=await send('Page.captureScreenshot',{format:'png'})
  writeFileSync(path.join(out,'black-large-compact.png'),Buffer.from(compactShot.data,'base64'))
  assert.deepEqual(errors,[])
  writeFileSync(path.join(out,'measurements.json'),JSON.stringify({results,tools,manualZoom,negativeControl,thousand,drill,overview,compact,errors},null,2))
  console.log(JSON.stringify({results:results.map(r=>({theme:r.theme,size:r.size,overlaps:r.streamBounds.overlaps.length,cards:r.cards.map(c=>Math.round(c.h)),nodeWidths:r.nodes.map(n=>Math.round(n.w)),zoom:r.zoom})),toolsOverlaps:tools.overlaps.length,manualZoom,negativeControl,thousand:{renderMs:thousand.renderMs,retainedNodes:thousand.retainedNodes,visibleNodes:thousand.nodes.length,culledNodes:thousand.culledNodes},errors}))
}finally{socket?.close();child?.kill();await server.close()}
