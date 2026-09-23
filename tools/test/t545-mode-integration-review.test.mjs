import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const hostPath = path.join(root, 'shell/agent-host.cjs')
let { createAgentHost } = require(hostPath)
// Mutation is memory-only: never rewrite the shared production source.
if (process.env.T545_REVIEW_MUTATION === 'receipt') {
  const original = readFileSync(hostPath, 'utf8')
  const broken = original.replace("confirmed?.currentModeId !== id || current.currentModeId !== id", "false")
  assert.notEqual(broken, original, 'mutation must actually alter the in-memory host')
  const mod = new Module(hostPath, moduleParent())
  mod.filename = hostPath
  mod.paths = Module._nodeModulePaths(path.dirname(hostPath))
  mod._compile(broken, hostPath)
  createAgentHost = mod.exports.createAgentHost
}
function moduleParent() { return require.cache[hostPath] }
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
async function fixture(t) {
  let state = { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'plan' }] }
  let settle, reject, sends = 0, selections = 0
  const calls = [], events = []
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const adapter = {
    transport: { child },
    getSessionModes: () => state,
    selectMode: (...args) => { selections++; calls.push(args); return new Promise((a,b) => { settle=a; reject=b }) },
    sendTurn: async () => { sends++; return { turnId: 'turn' } },
    interrupt: async () => {}, answerApproval() {}, updateThreadSettings: async () => {},
  }
  t.mock.method(engine, 'startCodexSession', async () => ({ threadId: 'thread', adapter, close() {} }))
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: root, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }) })
  await host.startSession({ sessionId: 'review', tier: 'luna' })
  host.onEvent(packet => events.push(packet))
  t.after(() => host.closeAll())
  return { host, adapter, events, calls, child, sends:()=>sends, selections:()=>selections,
    read:()=>host.readSessionModes({sessionId:'review'}),
    select:()=>host.setSessionMode({sessionId:'review',modeId:'plan'}),
    state: value => { state=value }, ack:value=>settle(value), reject:error=>reject(error),
    send:()=>host.sendTurn({sessionId:'review',text:'user follow-up'}) }
}
test('review: ACK alone cannot claim applied when authoritative provider refresh disagrees', async t => {
  const f=await fixture(t)
  const rejected=assert.rejects(f.select(), {code:'AGENT_MODE_SELECTION_UNCONFIRMED'})
  f.ack({currentModeId:'plan'})
  await rejected
  assert.equal(f.read().currentModeId,'ask')
  assert.equal(f.read().pending,false)
})
test('review: refreshed target alone cannot compensate for a wrong ACK', async t => {
  const f=await fixture(t)
  const rejected=assert.rejects(f.select(), {code:'AGENT_MODE_SELECTION_UNCONFIRMED'})
  f.state({currentModeId:'plan',availableModes:[{id:'ask'},{id:'plan'}]})
  f.ack({currentModeId:'ask'})
  await rejected
  assert.equal(f.read().currentModeId,'plan')
})
test('review: read-only catalog and selector without catalog advertise unsupported', async t => {
  const f=await fixture(t)
  const selector=f.adapter.selectMode
  delete f.adapter.selectMode
  assert.equal(f.read().supported,false)
  assert.deepEqual(f.read().availableModes,[])
  await assert.rejects(f.select(),{code:'AGENT_MODE_UNSUPPORTED'})
  f.adapter.selectMode=selector
  f.state({currentModeId:null,availableModes:[]})
  assert.equal(f.read().supported,false)
  await assert.rejects(f.select(),{code:'AGENT_MODE_UNSUPPORTED'})
  assert.equal(f.selections(),0)
})
test('review: manual user sequence select, Stop, refresh, retry retains provider truth', async t => {
  const f=await fixture(t)
  const first=assert.rejects(f.select(),{code:'AGENT_MODE_SELECTION_UNCONFIRMED'})
  await f.host.interrupt({sessionId:'review'})
  await assert.rejects(f.send(),{code:'AGENT_TURN_ACTIVE'})
  f.state({currentModeId:'plan',availableModes:[{id:'plan'},{id:'ask'}]})
  f.ack({currentModeId:'plan'})
  await first
  assert.equal(f.read().pending,false)
  assert.equal(f.read().currentModeId,'plan')
  const retry=f.select()
  f.ack({currentModeId:'plan'})
  assert.equal((await retry).applied,true)
  assert.deepEqual(f.calls,[['thread','plan'],['thread','plan']])
  await f.send()
  assert.equal(f.sends(),1)
})
test('review: provider refusal permits retry without stale pending lock', async t => {
  const f=await fixture(t)
  const first=assert.rejects(f.select(),{code:'REVIEW_REFUSED'})
  f.reject(Object.assign(new Error('refused'),{code:'REVIEW_REFUSED'}))
  await first
  const next=f.select()
  f.state({currentModeId:'plan',availableModes:[{id:'plan'}]})
  f.ack({currentModeId:'plan'})
  assert.equal((await next).applied,true)
})
test('review: close without replacement rejects delayed ACK by name', async t => {
  const f=await fixture(t)
  const result=assert.rejects(f.select(),{code:'AGENT_SESSION_UNKNOWN'})
  await f.host.closeSession({sessionId:'review'})
  f.ack({currentModeId:'plan'})
  await result
})
test('review: rewind cannot race pending mode selection', async t => {
  const f=await fixture(t)
  const result=f.select()
  await assert.rejects(f.host.rewindSession({sessionId:'review',turnId:'past'}),{code:'AGENT_TURN_ACTIVE'})
  f.state({currentModeId:'plan',availableModes:[{id:'plan'}]})
  f.ack({currentModeId:'plan'})
  await result
})
for (const name of ['fleet-profile-preload.cjs','remote-workspace-preload.cjs']) {
  test('review: '+name+' dispatches actual mode calls and preserves refusal',async()=>{
    const exposed={},calls=[]
    const ipcRenderer={on(){},removeListener(){},send(){},sendSync(){return null},invoke:async(channel,request)=>{
      calls.push({channel,request})
      if(name.startsWith('remote')) return {ok:true,status:200,value:{currentModeId:'plan',applied:true}}
      return {currentModeId:'plan',applied:true}
    }}
    const window={addEventListener(){}}
    vm.runInNewContext(readFileSync(path.join(root,'shell',name),'utf8'),{
      require:id=>{assert.equal(id,'electron');return {contextBridge:{exposeInMainWorld:(key,value)=>{exposed[key]=value}},ipcRenderer}},
      process:{platform:process.platform},window,document:{addEventListener(){}},console,setTimeout,clearTimeout,URL
    },{filename:name})
    const request={sessionId:'review',modeId:'plan'}
    assert.equal((await exposed.mcAgent.setMode(request)).applied,true)
    await exposed.mcAgent.modes({sessionId:'review'})
    if(name.startsWith('remote')) {
      assert.equal(calls[0].channel,'mc-remote:request')
      assert.equal(calls[0].request.operation,'agent:mode')
      assert.equal(calls[0].request.params,request)
      assert.equal(calls[1].request.operation,'agent:modes')
      ipcRenderer.invoke=async()=>({ok:true,status:403,value:{error:{code:'MC_AGENT_PRINCIPAL_READ_ONLY'}}})
    } else {
      assert.equal(calls[0].channel,'mc-agent:mode')
      assert.equal(calls[0].request,request)
      assert.equal(calls[1].channel,'mc-agent:modes')
      ipcRenderer.invoke=async()=>{throw Object.assign(new Error('refused'),{code:'MC_AGENT_PRINCIPAL_READ_ONLY'})}
    }
    await assert.rejects(exposed.mcAgent.setMode(request),{code:'MC_AGENT_PRINCIPAL_READ_ONLY'})
  })
}
