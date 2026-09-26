import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createProviderModeMenu } from '../../src/provider-mode-menu.js'
const require=createRequire(import.meta.url)
const root=path.resolve(import.meta.dirname,'../..')
const hostPath=path.join(root,'shell/agent-host.cjs')
let {createAgentHost}=require(hostPath)
if(process.env.T545_NATIVE_MUTATION==='catalog-cancel'){
  const source=readFileSync(hostPath,'utf8')
  const broken=source.replace('      assertCurrent()\n      if (!offered.supported)', '      if (!offered.supported)')
  assert.notEqual(broken,source,'in-memory mutation must apply')
  const mod=new Module(hostPath,require.cache[hostPath])
  mod.filename=hostPath; mod.paths=Module._nodeModulePaths(path.dirname(hostPath))
  mod._compile(broken,hostPath); createAgentHost=mod.exports.createAgentHost
}
const enginePath=path.join(root,'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine=require(enginePath)
const instructions='Native review retained instructions\nPreserve exact punctuation: < > &.'
async function fixture(t,{settings=true, effort='high', unavailableReason=null}={}){
  let resolveCatalog,rejectCatalog
  let state={currentModeId:'default',availableModes:[{id:'default'},{id:'plan'}]}
  const calls=[]
  const binding=settings?{model:'engine-confirmed-model',effort,developerInstructions:instructions}:null
  const adapter={
    modeSelectionRequiresSettings:true,
    transport:{child:Object.assign(new EventEmitter(),{exitCode:null,signalCode:null})},
    listCollaborationModes:()=>new Promise((resolve,reject)=>{resolveCatalog=resolve;rejectCatalog=reject}),
    getSessionModes:()=>state,
    selectMode:async(...args)=>{calls.push(args);state={...state,currentModeId:args[1]};return {...state,appliesOn:'next-turn'}},
    sendTurn:async()=>({turnId:'turn'}),interrupt:async()=>{},answerApproval(){},updateThreadSettings:async()=>{},
  }
  t.mock.method(engine,'startCodexSession',async()=>({threadId:'native-thread',adapter,nativeModeSettings:binding,nativeModeUnavailableReason:unavailableReason,close(){}}))
  const host=createAgentHost({enginePath,defaultCwd:root,profileRoot:root,freeMemory:()=>64*1024**3,
    confinementPlanner:()=>({ok:true,tier:'unrestricted',isolated:false,threadOptions:{developerInstructions:'Plan-only text must not become native settings'},env:{}})})
  await host.startSession({sessionId:'native-review',tier:'luna',effort:'high'})
  t.after(()=>host.closeAll())
  return {host,adapter,calls,binding,resolve:()=>resolveCatalog(),reject:()=>rejectCatalog(Object.assign(new Error('catalog refused'),{code:'NATIVE_CATALOG_REFUSED'})),
    select:()=>host.setSessionMode({sessionId:'native-review',modeId:'plan'}),
    read:()=>host.readSessionModes({sessionId:'native-review'})}
}
test('native review: delayed catalog reserves selection and preserves exact retained settings',async t=>{
  const f=await fixture(t)
  const selected=f.select()
  assert.equal(f.calls.length,0)
  await assert.rejects(f.host.sendTurn({sessionId:'native-review',text:'user follow-up'}),{code:'AGENT_TURN_ACTIVE'})
  await assert.rejects(f.select(),{code:'AGENT_TURN_ACTIVE'})
  f.resolve()
  const receipt=await selected
  assert.deepEqual(f.calls,[['native-thread','plan',{model:'engine-confirmed-model',effort:'high',developerInstructions:instructions}]])
  assert.equal(receipt.applied,true);assert.equal(receipt.currentModeId,'plan');assert.equal(receipt.pending,false)
  assert.equal(receipt.appliesOn,'next-turn')
})
test('native review: missing retained settings are named on read and selection',async t=>{
  const f=await fixture(t,{settings:false})
  const reading=f.read();f.resolve()
  const state=await reading
  assert.equal(state.supported,false);assert.equal(state.code,'CODEX_MODE_SETTINGS_REQUIRED')
  const rejected=assert.rejects(f.select(),{code:'CODEX_MODE_SETTINGS_REQUIRED'})
  f.resolve();await rejected
  assert.equal(f.calls.length,0)
  const refresh=f.read();f.resolve();assert.equal((await refresh).pending,false)
})
test('native review: Stop during catalog prevents provider selection',async t=>{
  const f=await fixture(t)
  const rejected=assert.rejects(f.select(),{code:'AGENT_MODE_SELECTION_UNCONFIRMED'})
  const stopped=await f.host.interrupt({sessionId:'native-review'})
  assert.equal(stopped.modeChangeUnconfirmed,true)
  f.resolve();await rejected
  assert.equal(f.calls.length,0,'Stop before catalog completion must prevent selectMode side effects')
  const refresh=f.read();f.resolve();assert.equal((await refresh).pending,false)
})
test('native review: close during catalog prevents provider selection',async t=>{
  const f=await fixture(t)
  const rejected=assert.rejects(f.select(),{code:'AGENT_SESSION_UNKNOWN'})
  await f.host.closeSession({sessionId:'native-review'})
  f.resolve();await rejected;assert.equal(f.calls.length,0)
})
test('native review: catalog refusal clears pending and permits user retry',async t=>{
  const f=await fixture(t)
  const rejected=assert.rejects(f.select(),{code:'NATIVE_CATALOG_REFUSED'})
  f.reject();await rejected;assert.equal(f.calls.length,0)
  const refresh=f.read();f.resolve();assert.equal((await refresh).pending,false)
  const retry=f.select();f.resolve();assert.equal((await retry).applied,true);assert.equal(f.calls.length,1)
})
test('native review: delayed read rejects replaced session identity',async t=>{
  const f=await fixture(t)
  const rejected=assert.rejects(f.read(),{code:'AGENT_SESSION_NOT_READY'})
  await f.host.closeSession({sessionId:'native-review'})
  await f.host.startSession({sessionId:'native-review',tier:'luna',effort:'high'})
  f.resolve();await rejected;assert.equal(f.calls.length,0)
})

test('native review: explicit resumed unavailable reason survives catalog and selection',async t=>{
  const reason='CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE'
  const f=await fixture(t,{settings:false,unavailableReason:reason})
  const reading=f.read();f.resolve()
  const state=await reading
  assert.equal(state.supported,false);assert.equal(state.code,reason)
  const refused=assert.rejects(f.select(),{code:reason});f.resolve();await refused
  assert.equal(f.calls.length,0)
  let requests=0
  const messages=[]
  const menu=createProviderModeMenu({sessionId:'native-review',bridge:{
    modes:request=>f.host.readSessionModes(request),
    setMode:request=>{requests++;return f.host.setSessionMode(request)},
  }})
  t.after(()=>menu.dispose())
  const ctx={show:rows=>assert.equal(typeof rows,'function'),say:message=>messages.push(message)}
  const opening=menu.open(ctx);f.resolve();await opening
  assert.deepEqual(menu.rows().filter(row=>['provider-mode-default','provider-mode-plan'].includes(row.id)).map(row=>row.label),['default','plan'])
  assert.match(messages.at(-1),/resumed session.*settings.*unavailable/i)
  assert.doesNotMatch(messages.at(-1),/does not support|fresh session|run a turn/i)
  const plan=menu.rows().find(row=>row.id==='provider-mode-plan')
  assert.equal(plan.enabled,false);assert.match(plan.disabledHint,/resumed session.*settings.*unavailable/i)
  await plan.run(ctx)
  assert.equal(requests,0);assert.equal(f.calls.length,0)
})
test('native review: engine-confirmed null effort stays null instead of requested start effort',async t=>{
  const f=await fixture(t,{effort:null})
  const selected=f.select();f.resolve();await selected
  assert.deepEqual(f.calls[0][2],{model:'engine-confirmed-model',effort:null,developerInstructions:instructions})
})
test('native review: acknowledged effort update changes retained effort only',async t=>{
  const f=await fixture(t)
  let finish
  f.adapter.updateThreadSettings=()=>new Promise(resolve=>{finish=resolve})
  const effort=f.host.setSessionEffort({sessionId:'native-review',effort:'low'})
  await assert.rejects(f.select(),{code:'AGENT_TURN_ACTIVE'})
  finish();await effort
  const selected=f.select();f.resolve();await selected
  assert.deepEqual(f.calls[0][2],{model:'engine-confirmed-model',effort:'low',developerInstructions:instructions})
})
test('native review: refused effort update preserves engine-confirmed binding',async t=>{
  const f=await fixture(t)
  f.adapter.updateThreadSettings=async()=>{throw Object.assign(new Error('refused'),{code:'EFFORT_REFUSED'})}
  await assert.rejects(f.host.setSessionEffort({sessionId:'native-review',effort:'low'}),{code:'EFFORT_REFUSED'})
  const selected=f.select();f.resolve();await selected
  assert.deepEqual(f.calls[0][2],{model:'engine-confirmed-model',effort:'high',developerInstructions:instructions})
})
test('native review: effort ACK cannot invent a missing native binding',async t=>{
  const f=await fixture(t,{settings:false})
  await f.host.setSessionEffort({sessionId:'native-review',effort:'low'})
  const refused=assert.rejects(f.select(),{code:'CODEX_MODE_SETTINGS_REQUIRED'})
  f.resolve();await refused;assert.equal(f.calls.length,0)
})
