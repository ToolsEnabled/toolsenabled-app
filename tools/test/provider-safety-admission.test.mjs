import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const directory = require('./fixtures/confined-engine/src/lib/agent-comms/tree-node-directory.js')
const provider = require('./fixtures/confined-engine/src/lib/providers/agent-comms-local.js')
async function fixture(t, { reservation = false } = {}) {
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'safety-review-'))
 engine.calls.length=0;engine.adapterCalls.length=0;directory.reset();provider.reset()
 const releases=[]
 let hold=false,release,entered
 const gate=new Promise(resolve=>{release=resolve})
 const waiting=new Promise(resolve=>{entered=resolve})
 const host=createAgentHost({enginePath,defaultCwd:scratch,freeMemory:()=>64*1024**3,
  assertTranscriptWritable:()=>{if(hold && !reservation){entered();return gate}},
  reserveTranscriptTurn:()=>{if(hold && reservation){entered();return gate.then(()=>({release:async value=>{releases.push(value);return {ok:true}}}))}},
  confinementPlanner:()=>({ok:true,tier:'standard',isolated:true,threadOptions:{sandbox:'workspace-write',approvalPolicy:'never'},
   env:{CODEX_HOME:path.join(scratch,'synthetic-home')},servers:['toolsenabled-readonly','toolsenabled']})})
 t.after(async()=>{release();await host.closeAll();directory.reset();provider.reset();fs.rmSync(scratch,{recursive:true,force:true})})
 await host.startSession({sessionId:'synthetic-review-session'})
 await host.sendTurn({sessionId:'synthetic-review-session',text:'Synthetic initial turn',origin:'person'})
 const refuse=(turnId='t1')=>engine.calls.at(-1).onEvent({type:'turn_completed',threadId:'thread-1',turnId,status:'failed',
  payload:{failure:{code:'misalignment_policy_violation',category:'safety-policy',retryable:false,summary:'Synthetic safety refusal.'}}})
 return {host,refuse,releases,complete:()=>engine.calls.at(-1).onEvent({type:'turn_completed',turnId:'t1',status:'completed'}),hold(){hold=true;return waiting},release,
  sends:()=>engine.adapterCalls.filter(row=>row.method==='sendTurn').length,
  blocked:()=>host.sessionActivity('synthetic-review-session').automaticTurnBlock?.code}
}
test('a refused person request cannot silently clear the automatic safety hold',async t=>{
 const f=await fixture(t);f.refuse()
 assert.equal(f.blocked(),'PROVIDER_SAFETY_REFUSAL')
 await assert.rejects(f.host.sendTurn({sessionId:'synthetic-review-session',text:'Synthetic new request',origin:'person',options:{model:17}}),{code:'AGENT_HOST_INVALID_ARGUMENT'})
 assert.equal(f.sends(),1)
 assert.equal(f.blocked(),'PROVIDER_SAFETY_REFUSAL')
})
test('a safety refusal during asynchronous admission still refuses automatic delivery',async t=>{
 const f=await fixture(t);const waiting=f.hold()
 const send=f.host.sendTurn({sessionId:'synthetic-review-session',text:'Synthetic automatic input',origin:'agent'}).then(value=>({value}),error=>({error}))
 await waiting;f.refuse();f.release()
 const result=await send
 assert.equal(result.error?.code,'PROVIDER_SAFETY_REFUSAL')
 assert.equal(f.sends(),1)
})

test('a safety refusal during transcript reservation prevents dispatch and releases unsent custody', async t => {
 const f=await fixture(t,{reservation:true});f.complete();const waiting=f.hold()
 const send=f.host.sendTurn({sessionId:'synthetic-review-session',text:'Synthetic reserved automatic input',origin:'agent'}).then(value=>({value}),error=>({error}))
 await waiting;f.refuse(null);f.release()
 const result=await send
 assert.equal(result.error?.code,'PROVIDER_SAFETY_REFUSAL')
 assert.equal(f.sends(),1)
 assert.deepEqual(f.releases,[{accepted:false,dispatched:false}])
 assert.equal(f.blocked(),'PROVIDER_SAFETY_REFUSAL')
})
