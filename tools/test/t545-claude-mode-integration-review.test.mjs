import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire,Module} from 'node:module'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {EventEmitter} from 'node:events'
import {canonicalRootForTests} from '../canonical-root.mjs'
const require=createRequire(import.meta.url)
const appRoot=path.resolve(import.meta.dirname,'../..')
const engineRoot=canonicalRootForTests({requireConfigured:true})
const adapterPath=path.join(engineRoot,'src/lib/agent-engine/claude-cli-adapter.js')
let {ClaudeCliAdapter}=require(adapterPath)
if(process.env.T545_CLAUDE_MUTATION==='ack'){
 const src=readFileSync(adapterPath,'utf8')
 const broken=src.replace("response.response?.mode !== modeId", "false")
 assert.notEqual(broken,src,'mutation must change memory-only module')
 const mod=new Module(adapterPath,require.cache[adapterPath]);mod.filename=adapterPath;mod.paths=Module._nodeModulePaths(path.dirname(adapterPath))
 mod._compile(broken,adapterPath);ClaudeCliAdapter=mod.exports.ClaudeCliAdapter
}
const {createAgentHost}=require('../../shell/agent-host.cjs')
const fixturePath=path.join(appRoot,'tools/test/fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
const fakeClaude=require(path.join(path.dirname(fixturePath),'claude-cli-process.js'))
async function fixture(t,policy={initialMode:'acceptEdits',allowedModes:['plan','default','acceptEdits']},timeout=1000){
 let receive
 const sent=[]
 const transport={child:Object.assign(new EventEmitter(),{exitCode:null,signalCode:null}),onData:fn=>{receive=fn},send:p=>sent.push(p),close(){}}
 const adapter=new ClaudeCliAdapter({transport,modePolicy:policy,modeTimeoutMs:timeout})
 const {threadId}=await adapter.startThread()
 t.after(()=>adapter.close())
 return {adapter,threadId,sent,receive:p=>receive(p),
  ack:(mode,subtype='success',id=sent.at(-1).request_id)=>receive({type:'control_response',response:{request_id:id,subtype,response:{mode}}}),
  select:mode=>adapter.selectMode(threadId,mode),
  turn:()=>adapter.sendTurn({threadId,text:'simulated user input'}),
  status:mode=>receive({type:'system',subtype:'status',session_id:threadId,permissionMode:mode}),
  finishTurn:()=>receive({type:'result',subtype:'success',session_id:threadId,result:'simulated reply'})}
}
test('Claude review: allowlist ceiling and denied controls dispatch nothing',async t=>{
 for(const [initialMode,allowedModes] of [['plan',['plan']],['default',['plan','default']],['manual',['plan','default']],['acceptEdits',['plan','default','acceptEdits']],['bypassPermissions',['plan','default']]]){
  const f=await fixture(t,{initialMode,allowedModes})
  assert.deepEqual(f.adapter.getSessionModes(f.threadId).availableModes.map(x=>x.id),allowedModes)
  for(const id of ['auto','bypassPermissions','dontAsk',...(initialMode==='plan'?['default','acceptEdits']:[])]){
   await assert.rejects(f.select(id),{code:'CLAUDE_MODE_NOT_ALLOWED'})
  }
  assert.equal(f.sent.length,0)
 }
})
test('Claude review: mismatched ACK creates uncertainty until successful reselection',async t=>{
 const f=await fixture(t)
 const first=assert.rejects(f.select('plan'),{code:'CLAUDE_MODE_UNCONFIRMED'});f.ack('default');await first
 await assert.rejects(f.turn(),{code:'CLAUDE_MODE_UNCONFIRMED'})
 const refused=assert.rejects(f.select('plan'),{code:'CLAUDE_MODE_REFUSED'});f.ack('plan','error');await refused
 await assert.rejects(f.turn(),{code:'CLAUDE_MODE_UNCONFIRMED'})
 const retry=f.select('default');f.ack('default');await retry
 const turn=f.turn();f.finishTurn();await turn
})
test('Claude review: timed-out request late ACK cannot finish its successor',async t=>{
 const f=await fixture(t,undefined,25)
 const first=assert.rejects(f.select('plan'),{code:'CLAUDE_MODE_TIMEOUT'})
 const stale=f.sent.at(-1).request_id;await first
 const retry=f.select('default')
 f.ack('plan','success',stale)
 await assert.rejects(f.turn(),{code:'CLAUDE_MODE_UNCONFIRMED'})
 assert.equal(f.adapter.getSessionModes(f.threadId).currentModeId,null)
 f.ack('default');assert.equal((await retry).currentModeId,'default')
})
test('Claude review: conflicting newer status fences ACK and successful retry restores turns',async t=>{
 const f=await fixture(t)
 const pending=assert.rejects(f.select('plan'),{code:'CLAUDE_MODE_UNCONFIRMED'})
 f.ack('plan');f.status('default');await pending
 await assert.rejects(f.turn(),{code:'CLAUDE_MODE_UNCONFIRMED'})
 const retry=f.select('plan');f.ack('plan');await retry
 const turn=f.turn();f.finishTurn();await turn
})
test('Claude review: explicit refusal retains prior confirmation and permits a turn',async t=>{
 const f=await fixture(t)
 const confirmed=f.select('plan');f.ack('plan');await confirmed
 const refused=assert.rejects(f.select('default'),{code:'CLAUDE_MODE_REFUSED'});f.ack('default','error');await refused
 assert.equal(f.adapter.getSessionModes(f.threadId).currentModeId,'plan')
 const turn=f.turn();f.finishTurn();await turn
})
test('Claude review: close and changed thread invalidate already-delivered ACK',async t=>{
 for(const operation of ['close','replace']){
  const f=await fixture(t)
  const replacement=operation==='replace'?(await fixture(t)).threadId:null
  const refused=assert.rejects(f.select('plan'),{code:'CLAUDE_MODE_UNCONFIRMED'})
  f.ack('plan')
  if(operation==='close')f.adapter.close()
  else await f.adapter.resumeThread(replacement)
  await refused
 }
})
async function hostFixture(t){
 const adapters=[]
 t.mock.method(fakeClaude,'startClaudeSession',async()=>{
  const f=await fixture(t)
  const original=f.adapter.selectMode.bind(f.adapter)
  const argCounts=[]
  f.adapter.selectMode=(...args)=>{argCounts.push(args.length);return original(...args)}
  adapters.push({...f,argCounts})
  return {threadId:f.threadId,adapter:f.adapter,close:()=>f.adapter.close()}
 })
 const host=createAgentHost({enginePath:fixturePath,defaultCwd:appRoot,profileRoot:appRoot,
  freeMemory:()=>64*1024**3,providerCommandResolver:()=>process.execPath,
  confinementPlanner:()=>({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{}})})
 await host.startSession({sessionId:'claude-review',tier:'claude-sonnet'})
 t.after(()=>host.closeAll())
 return {host,adapters,select:()=>host.setSessionMode({sessionId:'claude-review',modeId:'plan'})}
}
test('Claude review: host calls real Claude mode contract with two arguments and no Codex binding',async t=>{
 const f=await hostFixture(t),a=f.adapters[0]
 const state=await f.host.readSessionModes({sessionId:'claude-review'})
 assert.equal(state.provider,'claude');assert.equal(state.supported,true)
 const pending=f.select()
 await assert.rejects(f.host.sendTurn({sessionId:'claude-review',text:'blocked follow-up'}),{code:'AGENT_TURN_ACTIVE'})
 a.ack('plan');const receipt=await pending
 assert.equal(receipt.currentModeId,'plan');assert.equal(receipt.applied,true)
 assert.equal(receipt.appliesOn,'subsequent-turns');assert.deepEqual(a.argCounts,[2])
})
test('Claude review: host Stop refuses late ACK while refresh shows real provider result',async t=>{
 const f=await hostFixture(t),a=f.adapters[0]
 const refused=assert.rejects(f.select(),{code:'AGENT_MODE_SELECTION_UNCONFIRMED'})
 await f.host.interrupt({sessionId:'claude-review'})
 a.ack('plan');await refused
 assert.equal((await f.host.readSessionModes({sessionId:'claude-review'})).currentModeId,'plan')
})
test('Claude review: host replacement cannot accept old Claude ACK',async t=>{
 const f=await hostFixture(t),a=f.adapters[0]
 const refused=assert.rejects(f.select(),{code:'AGENT_SESSION_NOT_READY'})
 a.ack('plan')
 await f.host.closeSession({sessionId:'claude-review'})
 await f.host.startSession({sessionId:'claude-review',tier:'claude-sonnet'})
 await refused
 assert.equal((await f.host.readSessionModes({sessionId:'claude-review'})).currentModeId,null)
})

test('Claude review: real process derives manual and unsupported policies without trusting thread options',async t=>{
 const target=path.join(engineRoot,'src/lib/agent-engine/claude-cli-process.js')
 const originalLoad=Module._load,launches=[]
 function spawnHidden(command,args){
  const child=new EventEmitter()
  child.stdout=Object.assign(new EventEmitter(),{setEncoding(){}})
  child.stderr=Object.assign(new EventEmitter(),{setEncoding(){}})
  child.kill=()=>{}
  child.stdin={on(){},writable:true,end(){queueMicrotask(()=>child.emit('close',0))},write(raw){
   const packet=JSON.parse(raw)
   assert.equal(packet.type,'control_request','No provider turns or external process')
   queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({type:'control_response',response:{
    request_id:packet.request_id,subtype:'success',response:packet.request.subtype==='set_permission_mode'?{mode:packet.request.mode}:{}}})+'\n'))
   return true
  }}
  if(args.includes('--version'))queueMicrotask(()=>{child.stdout.emit('data','review-version');child.emit('close',0)})
  else launches.push(args)
  return child
 }
 Module._load=function(request,parent,...rest){
  if(parent?.filename===target&&request==='../proc/hidden-spawn')return {spawnHidden}
  if(parent?.filename===target&&request==='../runtime')return {rootPath(){throw Error('Review forbids runtime log writes')}}
  return originalLoad.call(this,request,parent,...rest)
 }
 try{
  const {startClaudeSession}=require(target)
  for(const mode of ['manual','auto','dontAsk',null]){
   const session=await startClaudeSession({cwd:appRoot,command:process.execPath,env:{},
    plan:{claudePermissionMode:mode,roleFunctionsOnly:true,agentApiMode:'Only'},
    threadOptions:{sandbox:'danger-full-access'}})
   try{
    const catalog=session.adapter.getSessionModes(session.threadId)
    if(mode==='manual'){
     assert.deepEqual(catalog.availableModes.map(x=>x.id),['plan','default'])
     assert.equal(launches.at(-1)[launches.at(-1).indexOf('--permission-mode')+1],'manual')
     assert.equal((await session.adapter.selectMode(session.threadId,'default')).currentModeId,'default')
    }else{
     assert.equal(catalog,null)
     await assert.rejects(session.adapter.selectMode(session.threadId,'plan'),{code:'CLAUDE_MODE_NOT_ALLOWED'})
    }
   }finally{await session.close()}
  }
 }finally{Module._load=originalLoad}
})
