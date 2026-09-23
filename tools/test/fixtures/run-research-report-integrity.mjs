// Explicit renderer-only fixture: fresh Dev profile, own loopback server,
// all non-fixture requests blocked. Does not open the desktop/LIVE app.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const dev = 'C:\\Users\\ToolsEnabled-Dev'
const temp = dev + '\\AppData\\Local\\Temp'
const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
assert.ok(root.toLowerCase().startsWith((dev + path.sep).toLowerCase()))
const out = mkdtempSync(path.join(temp, 'research-report-preview-'))
const profile = path.join(out, 'browser')
const server = await createServer({root, configFile:false, server:{host:'127.0.0.1',port:0,fs:{allow:[root,path.resolve(root,'../deps/app-node_modules')]}},logLevel:'error'})
let child, socket, send
const errors=[], blocked=[], results=[]
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
try {
  await server.listen()
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`
  const env={...process.env,TEMP:temp,TMP:temp,USERPROFILE:dev,APPDATA:dev+'\\AppData\\Roaming',LOCALAPPDATA:dev+'\\AppData\\Local'}
  for(const key of Object.keys(env)) if(/(?:TOKEN|API_KEY|SECRET|PASSWORD|AUTH)/i.test(key)||/^(?:HOME|ELECTRON_RUN_AS_NODE)$/i.test(key))delete env[key]
  child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
    '--disable-sync','--disable-extensions','--metrics-recording-only','--safebrowsing-disable-auto-update',
    '--password-store=basic','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank',
  ],{cwd:root,windowsHide:true,env,stdio:['ignore','ignore','pipe']})
  let stderr=''
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000)})
  console.log(JSON.stringify({out,profile,mode:'synthetic renderer-only report fixture',spawnedPid:child.pid}))
  let port
  for(let n=0;n<200;n++){try{port=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await pause(50)}
  assert.ok(port,'Fixture browser did not answer: '+stderr)
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  let seq=0
  const pending=new Map()
  send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timeout: '+method))},15000)
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))
  })
  socket.addEventListener('message',event=>{
    const msg=JSON.parse(event.data)
    if(msg.id){const item=pending.get(msg.id);if(!item)return;pending.delete(msg.id);clearTimeout(item.timer);msg.error?item.reject(Error(JSON.stringify(msg.error))):item.resolve(msg.result)}
    else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text)
    else if(msg.method==='Fetch.requestPaused'){
      const url=msg.params.request.url,allowed=url.startsWith(origin+'/')||url.startsWith('data:')||url==='about:blank'
      if(!allowed)blocked.push(url)
      void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId:msg.params.requestId,...(allowed?{}:{errorReason:'BlockedByClient'})}).catch(error=>errors.push(error.message))
    }
  })
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]})
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false})
  await send('Page.navigate',{url:origin+'/tools/test/fixtures/research-report-integrity.html'})
  for(let n=0;n<400;n++){if(await evaluate('!!window.researchReportReady'))break;await pause(50)}
  assert.ok(await evaluate('!!window.researchReportReady'),errors.join('\n')||'Fixture did not become ready')
  for(const theme of ['white','tan','black']){
    const measured=await evaluate(`window.researchReport.mount(${JSON.stringify(theme)})`)
    assert.equal(measured.headers.length,7)
    assert.ok(measured.rows.every(row=>row.length===measured.headers.length))
    assert.deepEqual(measured.rows[0].slice(0,5),['5','input A','99','reported A','false'])
    assert.deepEqual(measured.rows[1].slice(2,5),['—','—','—'])
    assert.deepEqual(measured.evidence,['collected','dispatch-only','execution-only','unverified'])
    assert.deepEqual(measured.chart,[{label:'5 · input A',value:99}])
    assert.equal(measured.json.rows[0].inputs.score,5)
    assert.equal(measured.json.rows[0].result.score,99)
    assert.equal(measured.overflow,false)
    const shot=await send('Page.captureScreenshot',{format:'png'})
    const file=path.join(out,theme+'.png')
    writeFileSync(file,Buffer.from(shot.data,'base64'));results.push({theme,file,...measured})
    console.log(JSON.stringify({theme,file,columns:measured.headers.length,rows:measured.rows.length,evidence:measured.evidence,chart:measured.chart}))
  }
  const designer=await evaluate('window.researchReport.checkDesigner()')
  assert.deepEqual(designer,{writes:1,pins:1,stdin:'params-json',args:['','  exact argument  '],receiptSettings:{retain:true},refused:['http','agent']})
  results.push({designer});console.log(JSON.stringify({designer}))
  assert.deepEqual(errors,[])
} finally {
  writeFileSync(path.join(out,'measurements.json'),JSON.stringify({results,errors,blocked},null,2))
  if(send)try{await send('Browser.close')}catch{}
  socket?.close();child?.kill();await server.close()
}
