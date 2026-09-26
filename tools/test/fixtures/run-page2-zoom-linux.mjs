// Fresh isolated renderer/browser artifacts; no live app or provider execution.
import { createServer } from 'vite'
import { spawn, execFileSync } from 'node:child_process'
import { realpathSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if(process.platform!=='linux') throw Error('Linux only')
const negativeControl=process.argv[3]
if(negativeControl && !['--negative-control=freeze','--negative-control=blocked'].includes(negativeControl))throw Error('Unknown negative control')
const out=mkdtempSync('/tmp/page2-zoom-linux-')
const browser=process.argv[2]
if(!browser || !path.isAbsolute(browser) || !existsSync(browser)) throw Error('Supply an absolute Linux Chromium executable path')
console.log('Artifacts: '+out)
const here=path.dirname(fileURLToPath(import.meta.url))
const root=path.resolve(here,'../../..')
const provenance={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),status:execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}),diff:execFileSync('git',['diff','HEAD','--','src/tree-graph.js','src/tree-graph.css','tools/test/fixtures/run-page2-zoom-linux.mjs'],{cwd:root,encoding:'utf8'}),negativeControl:negativeControl||null}
writeFileSync(path.join(out,'provenance.json'),JSON.stringify(provenance,null,2))
const server=await createServer({root,cacheDir:path.join(out,'vite-cache'),configFile:false,server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**']},fs:{allow:[root,realpathSync(path.join(root,'node_modules'))]}},logLevel:'error'})
let child, socket,cleanupPromise
const pending=new Map()
const cleanup=()=>cleanupPromise||=(async()=>{
  socket?.close()
  for(const p of pending.values())clearTimeout(p.timer)
  pending.clear()
  if(child?.pid){
    const signal=kind=>{try{process.kill(-child.pid,kind)}catch(error){if(error.code!=='ESRCH')throw error}}
    const exited=child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve))
    signal('SIGTERM')
    let timer
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,1500)})])
    clearTimeout(timer)
    signal('SIGKILL') // Bound teardown of any remaining processes in our own group.
    if(child.exitCode===null&&child.signalCode===null)await exited
  }
  await server.close()
})()
for(const [signal,code] of [['SIGINT',130],['SIGTERM',143]])process.once(signal,()=>{
  cleanup().then(()=>process.exit(code),error=>{console.error(error);process.exit(1)})
})
try{
  await server.listen()
  const port=server.httpServer.address().port
  const origin=`http://127.0.0.1:${port}`
  const profile=mkdtempSync(path.join(out,'browser-'))
  const env={PATH:process.env.PATH,HOME:profile,XDG_CONFIG_HOME:profile,XDG_CACHE_HOME:profile,TMPDIR:out,LANG:'C.UTF-8'}
  child=spawn(browser,[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--metrics-recording-only','--safebrowsing-disable-auto-update','--password-store=basic','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank',
  ],{cwd:root,env,detached:true,stdio:['ignore','ignore','pipe']})
  child.stderr.on('data',data=>writeFileSync(path.join(out,'browser-stderr.log'),data,{flag:'a'}))
  child.on('error',error=>writeFileSync(path.join(out,'browser-spawn-error.txt'),String(error)))
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  let debugPort
  for(let n=0;n<160;n++){try{debugPort=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await delay(50)}
  if(!debugPort)throw Error('Isolated browser did not become ready')
  const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  let id=0
  const errors=[],requests=[]
  const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(Error(`Timeout: ${method}`))},15000);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}))})
  socket.addEventListener('message',event=>{
    const msg=JSON.parse(event.data)
    if(msg.id){const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result)}
    else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text)
    else if(msg.method==='Fetch.requestPaused'){const allowed=msg.params.request.url.startsWith(origin+'/')||msg.params.request.url.startsWith('data:');requests.push({url:msg.params.request.url,allowed});void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId:msg.params.requestId,...(allowed?{}:{errorReason:'BlockedByClient'})})}
  })
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Page.bringToFront')
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await send('Page.navigate',{url:origin+'/tools/test/fixtures/page2-zoom-linux.html'})
  for(let n=0;n<160;n++){if(await evaluate('!!window.page2LayoutReady'))break;await delay(50)}
  if(!await evaluate('!!window.page2LayoutReady'))throw Error('Fixture did not load: '+errors.join('\n'))
  if(negativeControl==='--negative-control=blocked')await evaluate('fetch("http://fixture-negative.invalid/probe").catch(()=>null)')
  const results=[],failures=[]
  const check=(condition,message)=>{if(!condition)failures.push(message)}
  const snapshot=()=>evaluate('window.linuxZoom.snapshot()')
  const click=async selector=>{
    const target=await evaluate(`window.linuxZoom.target(${JSON.stringify(selector)})`)
    // Dispatch even when obscured: capture what a real pointer actually does.
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1})
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1})
    await delay(300)
    return target
  }
  const key=async key=>{
    const codes={'+':['Equal',187],'-':['Minus',189],'0':['Digit0',48],Enter:['Enter',13],' ':['Space',32]}
    const [code,windowsVirtualKeyCode]=codes[key]
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r'}:{})})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode})
    await delay(300)
  }
  const close=(a,b)=>Math.abs(a-b)<1e-6
  for(const placement of negativeControl?['bar']:['bar','host'])for(const count of negativeControl?[5]:[5,1000])for(const size of negativeControl?[1]:[.9,1,1.12]){
    const label=`${placement}-${count}-${size}`
    const initial=await evaluate(`window.linuxZoom.mount(${JSON.stringify({placement,count,size})})`)
    const result={label,placement,count,size,initial,actions:[]}
    const shot=async suffix=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(out,`${label}-${suffix}.png`),Buffer.from(r.data,'base64'))}
    await shot('before')
    for(const [name,selector] of [['plus','.gz-in'],['minus','.gz-out'],['plus-again','.gz-in'],['reset','.gz-level']]){
      const before=await snapshot(),target=await click(selector),after=await snapshot()
      result.actions.push({name,target,before,after})
      check(target.hit,`${label}/${name}: button obscured by ${target.hitTag}.${target.hitClass}`)
      if(name.startsWith('plus'))check(after.zoom>before.zoom,`${label}/${name}: zoom did not increase`)
      if(name==='minus')check(after.zoom<before.zoom,`${label}/${name}: zoom did not decrease`)
      if(name==='reset')check(close(after.zoom,initial.zoom),`${label}/${name}: overview zoom not restored`)
      if(name!=='reset')check(after.computedTransform!==before.computedTransform,`${label}/${name}: transform unchanged`)
      await shot(name)
    }
    check(await evaluate('window.linuxZoom.focusNode()'),`${label}: visible node cannot focus`)
    for(const k of ['+','-','+','0']){
      const before=await snapshot();await key(k);const after=await snapshot()
      result.actions.push({name:'keyboard '+k,before,after})
      check(k==='0'?close(after.zoom,initial.zoom):k==='+'?after.zoom>before.zoom:after.zoom<before.zoom,`${label}/keyboard ${k}: incorrect zoom`)
    }
    if(negativeControl==='--negative-control=freeze')await evaluate(`(()=>{const graph=document.querySelector('.fixture-graph');const style=document.createElement('style');style.textContent='.fixture-graph{transform:'+getComputedStyle(graph).transform+' !important}';document.head.append(style)})()`)
    await evaluate('window.linuxZoom.focusButton(".gz-in")')
    const before=await snapshot();await key('Enter');const after=await snapshot()
    result.actions.push({name:'button Enter',before,after})
    check(close(after.zoom,before.zoom*1.2),`${label}/button Enter: expected exactly one zoom step`)
    const resetBefore=await snapshot(),resetTarget=await click('.gz-level'),resetAfter=await snapshot()
    result.actions.push({name:'reset after keyboard zoom',target:resetTarget,before:resetBefore,after:resetAfter})
    check(resetTarget.hit && close(resetAfter.zoom,initial.zoom) && resetAfter.zoom<resetBefore.zoom,`${label}/reset after keyboard: overview not restored`)
    // Sibling toolbar focus is a distinct event path from graph-node focus.
    await evaluate('window.linuxZoom.focusButton(".gz-in")')
    await key('Enter')
    for(const k of ['+','-','0']){
      const before=await snapshot();await key(k);const after=await snapshot()
      result.actions.push({name:'toolbar keyboard '+k,before,after})
      const crossed=before.rootId!==after.rootId
      const validCrossing=crossed && (k==='+'?!before.rootId&&!!after.rootId&&after.zoom>before.zoom:!!before.rootId&&after.zoom<before.zoom)
      check(k==='0'?close(after.zoom,initial.zoom):crossed?validCrossing:k==='+'?after.zoom>before.zoom:after.zoom<before.zoom,`${label}/toolbar keyboard ${k}: incorrect zoom or branch transition`)
    }
    for(const [name,selector] of [['plus','.gz-in'],['minus','.gz-out'],['plus-again','.gz-in'],['reset','.gz-level']]){
      await evaluate(`window.linuxZoom.focusButton(${JSON.stringify(selector)})`)
      const before=await snapshot();await key(' ');const after=await snapshot()
      result.actions.push({name:'button Space '+name,before,after})
      check(close(after.zoom,name==='reset'?initial.zoom:before.zoom*(name==='minus'?1/1.2:1.2)),`${label}/button Space ${name}: expected exactly one native activation`)
    }
    for(const action of result.actions){
      const {name,before,after}=action
      const matrix=after.computedTransform==='none'?[1,0,0,1,0,0]:after.computedTransform.match(/^matrix\((.*)\)$/)?.[1].split(',').map(Number)
      check(matrix?.length===6 && Math.abs(matrix[0]-after.zoom)<1e-4 && Math.abs(matrix[3]-after.zoom)<1e-4,`${label}/${name}: painted scale disagrees with zoom`)
      const readout=Number(after.readout.match(/([0-9.]+)×/)?.[1])
      check(Number.isFinite(readout)&&Math.abs(readout-after.zoom)<=.0051,`${label}/${name}: readout disagrees with zoom`)
      if(!close(before.zoom,after.zoom))check(before.computedTransform!==after.computedTransform,`${label}/${name}: painted transform did not change`)
      if(name.includes('reset')||name.endsWith(' 0')){
        check(!close(before.zoom,initial.zoom),`${label}/${name}: reset was not exercised from displaced zoom`)
        check(['zoom','panX','panY'].every(k=>Math.abs(after[k]-initial[k])<.001),`${label}/${name}: overview zoom/pan not restored`)
      }
    }
    await shot('keyboard')
    results.push(result)
    writeFileSync(path.join(out,'measurements.json'),JSON.stringify({provenance,results,failures,errors,requests},null,2))
    console.log(label+': '+failures.filter(f=>f.startsWith(label)).length+' failures')
  }
  // Compare real input paths from the same rooted state. A stepped minus used
  // to strand the branch below the wheel's release threshold.
  const branchResults=[]
  for(const input of ['button','keyboard','wheel']){
    await evaluate('window.linuxZoom.mount({placement:"bar",count:1000,size:1})')
    const before=await evaluate('window.linuxZoom.prepareBranch()')
    check(before.rootId==='node-1'&&before.visible<before.total,`branch/${input}: rooted precondition missing`)
    for(let step=0;step<20&&(await snapshot()).rootId;step++){
      if(input==='button')await click('.gz-out')
      else if(input==='keyboard'){await evaluate('window.linuxZoom.focusButton(".gz-out")');await key('-')}
      else {await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.host.x+before.host.width/2,y:before.host.y+before.host.height/2,deltaX:0,deltaY:120});await delay(400)}
    }
    const after=await snapshot()
    check(!after.rootId&&after.represented===after.total&&after.visible<=21,`branch/${input}: release did not restore the complete grouped tree`)
    const matrix=after.computedTransform==='none'?[1,0,0,1,0,0]:after.computedTransform.match(/^matrix\((.*)\)$/)?.[1].split(',').map(Number)
    check(matrix?.length===6&&Math.abs(matrix[0]-after.zoom)<1e-4&&Math.abs(matrix[3]-after.zoom)<1e-4,`branch/${input}: released view was not painted`)
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:after.host.x+after.host.width/2,y:after.host.y+after.host.height/2,deltaX:0,deltaY:120})
    await delay(400)
    const followup=await snapshot()
    check(!followup.rootId&&followup.represented===followup.total&&followup.zoom<after.zoom,`branch/${input}: follow-up wheel-out stranded the branch`)
    branchResults.push({input,before,after,followup})
  }
  check(errors.length===0,'Browser exceptions: '+errors.join('\n'))
  check(requests.every(request=>request.allowed),'Unexpected blocked page request')
  const browserVersion=await send('Browser.getVersion')
  writeFileSync(path.join(out,'measurements.json'),JSON.stringify({provenance,browserVersion,results,branchResults,failures,errors,requests},null,2))
  console.log(JSON.stringify({out,cases:results.length,failures},null,2))
  if(failures.length)process.exitCode=1
}finally{await cleanup()}
