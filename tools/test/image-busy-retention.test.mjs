import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createRequire} from 'node:module'
import {randomUUID,createHash} from 'node:crypto'
const require=createRequire(import.meta.url)
const app=path.resolve(import.meta.dirname,'../..')
const {createImageRetentionService}=require('../../shell/image-retention-service.cjs')
const {createAgentHost}=require('../../shell/agent-host.cjs')
const hash=value=>createHash('sha256').update(value).digest('hex')
const temp=process.env.IMAGE_TEST_TEMP || os.tmpdir()
const bytes=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')
async function fixture(t,{host=false}={}) {
 const root=fs.mkdtempSync(path.join(temp,'image-busy-retained-'))
 t.diagnostic('RETAINED '+root)
 const file=path.join(root,'synthetic.gif');fs.writeFileSync(file,bytes)
 const context={},session={},issued=new Set(),calls=[]
 let native=null,onEvent=null,unavailable=false
 if(host) {
  const enginePath=path.join(app,'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  const engine=require(enginePath),original=engine.startCodexSession
  engine.startCodexSession=async options=>{
   onEvent=options.onEvent
   return {threadId:'fixture-thread',close(){},adapter:{async sendTurn(request){calls.push(request);return{turnId:'turn-'+calls.length}},async interrupt(){}}}
  }
  native=createAgentHost({enginePath,defaultCwd:root,freeMemory:()=>64*1024**3,
   confinementPlanner:()=>({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{}})})
  try {await native.startSession({sessionId:'session'})}finally{engine.startCodexSession=original}
  t.after(()=>native.closeAll())
 }
 const options={root:path.join(root,'retention'),authenticate:c=>{assert.equal(c,context);return{authenticated:true,productOwnerId:'owner'}},
  sourceAuthority:()=>({accountId:'account',provider:'codex',issued:new Set([file])}),
  candidateAuthority:()=>{if(unavailable) throw Object.assign(new Error('synthetic retired target'),{code:'MC_AGENT_UNKNOWN_SESSION'});return {session,sessionId:'session',accountId:'account',provider:'codex',issued,...(native?.sessionDeliverySettings('session')||{})}},
  authorizeTransfer:()=>true,engineImageBytes:3000000}
 let service=createImageRetentionService(options)
 const run=request=>service.run({conversationId:'conversation',...request},context)
 const receipt=run({operation:'retain',operationId:randomUUID(),images:[{path:file}]}).result
 let saved=run({operation:'admit',operationId:randomUUID(),expectedGeneration:null,text:'synthetic words',imageReceipts:[receipt]}).result
 saved=run({operation:'transfer',operationId:randomUUID(),expectedGeneration:saved.generation,expectedDestinationSessionId:null,destinationSessionId:'session'}).result
 const outbox=path.join(options.root,hash('owner'),hash('conversation'),'outbox')
 const request=()=>({conversationId:'conversation',envelopeId:saved.entries[0].envelopeId,expectedGeneration:run({operation:'read'}).result.generation,operationId:randomUUID()})
 return {root,run,outbox,receipt,saved,calls,native,request,
  complete:()=>onEvent({type:'turn_completed',turnId:'turn-'+calls.length,status:'completed'}),
  dispatch:send=>service.dispatch(request(),context,send),
  reopen(){service=createImageRetentionService(options)},
  retire(){unavailable=true},
 }
}
function fill(h,count) {
 const previous=JSON.parse(fs.readFileSync(path.join(h.outbox,'1','snapshot.json'),'utf8'))
 let generation=previous.generation
 for(let index=2;index<count;index++) {
  const {checksum,...record}=previous
  Object.assign(record,{index,generation:randomUUID(),operationId:randomUUID(),previous:generation})
  generation=record.generation
  fs.mkdirSync(path.join(h.outbox,String(index)))
  fs.writeFileSync(path.join(h.outbox,String(index),'snapshot.json'),JSON.stringify({...record,checksum:hash(JSON.stringify(record))}))
 }
}
test('busy real host preserves one image envelope without revision churn and delivers once at the turn boundary',async t=>{
 const h=await fixture(t,{host:true})
 await h.native.sendTurn({sessionId:'session',text:'synthetic in-flight work',origin:'agent'})
 const before=h.run({operation:'read'}).result
 for(let i=0;i<127;i++) {
  const reply=await h.dispatch(request=>h.native.sendTurnTracked({...request,origin:'person'}))
  assert.equal(reply.deliveryDisposition,'not-sent')
  assert.equal(reply.code,'AGENT_TURN_ACTIVE')
  assert.equal(reply.dispatchStarted,false,'a known busy target must not consume a dispatch attempt')
  assert.equal(reply.retryable,true)
 }
 assert.deepEqual(h.run({operation:'read'}).result,before)
 assert.equal(h.calls.length,1)
 h.complete()
 const accepted=await h.dispatch(request=>h.native.sendTurnTracked({...request,origin:'person'}))
 assert.equal(accepted.deliveryDisposition,'accepted')
 assert.equal(h.calls.length,2)
 assert.equal(h.calls[1].text,'synthetic words')
 assert.deepEqual(h.calls[1].images.map(image=>fs.readFileSync(image.path)),[bytes])
 await assert.rejects(()=>h.dispatch(request=>h.native.sendTurnTracked({...request,origin:'person'})),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
 assert.equal(h.calls.length,2)
})
test('a retained full outbox survives relaunch and explicit remove archives every old revision',async t=>{
 const h=await fixture(t);fill(h,256);h.reopen()
 const before=h.run({operation:'read'}).result
 const old=fs.readFileSync(path.join(h.outbox,'0','snapshot.json'))
 assert.equal(before.entries[0].text,'synthetic words')
 const cancellation={operation:'cancel',operationId:randomUUID(),expectedGeneration:before.generation,envelopeIds:[before.entries[0].envelopeId]}
 const cancelled=h.run(cancellation).result
 assert.deepEqual(h.run(cancellation).result,cancelled,'the identical operation keeps its receipt across maintenance')
 assert.equal(cancelled.entries[0].state,'cancelled')
 assert.deepEqual(cancelled.entries[0].imageReceipts,before.entries[0].imageReceipts)
 const archives=fs.readdirSync(path.join(h.outbox,'archive'))
 assert.equal(archives.length,1)
 assert.deepEqual(fs.readFileSync(path.join(h.outbox,'archive',archives[0],'0','snapshot.json')),old)
 assert.equal(fs.readdirSync(path.join(h.outbox,'archive',archives[0])).length,257)
 h.reopen();assert.equal(h.run({operation:'read'}).result.entries[0].state,'cancelled')
})
test('dispatch reserves completion capacity before the adapter accepts an image',async t=>{
 const h=await fixture(t);fill(h,255)
 let sends=0
 const accepted=await h.dispatch(async()=>{sends++;return{deliveryDisposition:'accepted',result:{turnId:'synthetic-turn'}}})
 assert.equal(accepted.deliveryDisposition,'accepted')
 assert.equal(accepted.reconcile,false,'the accepted receipt must fit beside its durable claim')
 assert.equal(h.run({operation:'read'}).result.entries[0].state,'accepted')
 assert.equal(sends,1)
})
test('a proven terminal refusal persists with its words and image after service relaunch',async t=>{
 const h=await fixture(t)
 const refused=await h.dispatch(async()=>({deliveryDisposition:'not-sent',code:'AGENT_IMAGE_UNSUPPORTED'}))
 assert.equal(refused.deliveryDisposition,'not-sent');assert.equal(refused.reconcile,false)
 h.reopen()
 const entry=h.run({operation:'read'}).result.entries[0]
 assert.equal(entry.text,'synthetic words');assert.equal(entry.imageReceipts.length,1)
 assert.deepEqual(entry.failure,{code:'AGENT_IMAGE_UNSUPPORTED',retryable:false})
})
test('interrupted revision archival remains visible and the next explicit action completes it',async t=>{
 const h=await fixture(t);fill(h,256)
 const before=h.run({operation:'read'}).result
 const original=fs.renameSync
 let interrupted=false
 fs.renameSync=(from,to)=>{
  if(!interrupted && to.includes(path.sep+'archive'+path.sep)){interrupted=true;throw Object.assign(new Error('synthetic interruption'),{code:'EIO'})}
  return original(from,to)
 }
 try {
  assert.throws(()=>h.run({operation:'cancel',operationId:randomUUID(),expectedGeneration:before.generation,envelopeIds:[before.entries[0].envelopeId]}),{code:'EIO'})
 } finally {fs.renameSync=original}
 h.reopen()
 const retained=h.run({operation:'read'}).result
 assert.equal(retained.writeBlocked,'IMAGE_OUTBOX_CLEANUP_REQUIRED')
 assert.equal(retained.entries[0].text,before.entries[0].text)
 const after=h.run({operation:'cancel',operationId:randomUUID(),expectedGeneration:retained.generation,envelopeIds:[retained.entries[0].envelopeId]}).result
 assert.equal(after.entries[0].state,'cancelled')
 assert.equal(h.run({operation:'read'}).result.writeBlocked,undefined)
})
test('an unknown delivery remains unknown across capacity maintenance and is never resent',async t=>{
 const h=await fixture(t);fill(h,255)
 let calls=0
 const reply=await h.dispatch(async()=>{calls++;throw Object.assign(new Error('synthetic uncertain adapter'),{code:'TEST_UNCERTAIN'})})
 assert.equal(reply.deliveryDisposition,'unknown')
 h.reopen()
 const saved=h.run({operation:'read'}).result
 assert.equal(saved.entries[0].state,'unknown')
 assert.equal(saved.entries[0].text,'synthetic words')
 await assert.rejects(()=>h.dispatch(async()=>{calls++;return{deliveryDisposition:'accepted'}}),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
 assert.equal(calls,1)
})
test('an unknown target is refused before dispatch and its terminal outcome survives relaunch without revision churn',async t=>{
 const h=await fixture(t);h.retire()
 let sends=0
 const send=async()=>{sends++;return{deliveryDisposition:'accepted'}}
 const first=await h.dispatch(send)
 assert.equal(first.code,'MC_AGENT_UNKNOWN_SESSION')
 assert.equal(first.dispatchStarted,false)
 assert.equal(first.retryable,false)
 const saved=h.run({operation:'read'}).result
 assert.deepEqual(saved.entries[0].failure,{code:'MC_AGENT_UNKNOWN_SESSION',retryable:false})
 h.reopen()
 for(let i=0;i<127;i++) await h.dispatch(send)
 assert.deepEqual(h.run({operation:'read'}).result,saved)
 assert.equal(sends,0)
})
