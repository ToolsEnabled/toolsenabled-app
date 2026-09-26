import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageQueueClient, admitImageComposerIntent } from '../../src/image-queue-client.js'
const tick=()=>new Promise(r=>setTimeout(r,0))
const wait=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const context=Object.freeze({version:1,ownerId:'owner',currentEpoch:'epoch',kind:'local'})
const ref={version:1,id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',slot:0,manifestHash:'a'.repeat(64),imageCount:2}
const snapshot=(entries=[],generation=null)=>({version:1,generation,entries,destinationSessionId:null,automaticSend:false})
const payload={operationId:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',text:'  exact\n  ',images:[{path:'/one'},{path:'/two'}]}
function setup(intercept=()=>undefined){
 let current=true,counter=0
 const calls=[]
 const owner={capture:()=>current?context:null,isCurrent:x=>current&&x===context,invalidate:()=>{current=false}}
 const bridge={imageQueue:async r=>{
  calls.push(structuredClone(r))
  const replacement=intercept(r);if(replacement!==undefined)return replacement
  let result
  if(r.operation==='binding')return{ok:true,result:{conversationId:'conversation',sessionId:'session',ownerContext:context}}
  if(r.operation==='read')result=snapshot()
  if(r.operation==='retain')result={...ref,state:'retained'}
  if(r.operation==='admit')result=snapshot([{envelopeId:'cccccccc-cccc-4ccc-cccc-cccccccccccc',text:r.text,imageReceipts:r.imageReceipts,selection:r.selection||{model:'test-model',effort:null},state:'not-sent'}],'generation')
  return{ok:true,operation:r.operation,operationId:r.operationId||null,result}
 }}
 const client=createImageQueueClient({bridge,owner,sessionId:'session',newOperationId:()=> 'dddddddd-dddd-4ddd-dddd-'+String(++counter).padStart(12,'0')})
 return{client,calls,detach:()=>{current=false}}
}
test('binding read retain admit preserves exact text/order; success remains not-sent',async()=>{
 const f=setup();const result=await f.client.admit(payload)
 assert.equal(result.ok,true);assert.equal(result.entry.text,payload.text);assert.equal(result.entry.state,'not-sent')
 assert.deepEqual(f.calls.map(r=>r.operation),['binding','read','retain','admit'])
 assert.deepEqual(f.calls[2].images,payload.images);assert.deepEqual(f.calls[3].imageReceipts,[ref])
 assert.equal(f.calls[3].expectedGeneration,null);assert.equal(result.automaticSend,false)
})
test('same operation coalesces; mismatch and concurrent admission refuse without extra writes',async()=>{
 const deferred=wait();const f=setup(r=>r.operation==='retain'?deferred.promise:undefined)
 const a=f.client.admit(payload),b=f.client.admit(payload);assert.equal(a,b)
 assert.equal((await f.client.admit({...payload,text:'different'})).ok,false)
 assert.equal((await f.client.admit({...payload,operationId:'other'})).code,'IMAGE_QUEUE_BUSY')
 await tick();const request=f.calls.at(-1)
 deferred.resolve({ok:true,operation:'retain',operationId:request.operationId,result:{...ref,state:'retained'}})
 assert.equal((await a).ok,true);assert.equal(f.calls.filter(r=>r.operation==='admit').length,1)
})
test('conflict retains assets and immutable intent; repeated click never retries stale value',async()=>{
 const f=setup(r=>{if(r.operation==='admit')throw Object.assign(new Error('stale'),{code:'IMAGE_OUTBOX_STALE'})})
 assert.equal((await f.client.admit(payload)).code,'IMAGE_OUTBOX_STALE')
 await f.client.admit(payload)
 assert.equal(f.calls.filter(r=>r.operation==='read').length,1);assert.equal(f.calls.filter(r=>r.operation==='admit').length,1)
 assert.deepEqual(f.client.pending(payload.operationId).imageReceipts,[ref])
 assert.equal(f.client.pending(payload.operationId).intent.text,payload.text)
})
test('postcommit owner refusal preserves diagnostics without adopting refused CAS generation',async()=>{
 const f=setup(r=>r.operation==='admit'?{ok:false,code:'IMAGE_OWNER_CHANGED',committed:true,operationId:r.operationId,generation:'committed-generation',reconcile:true}:undefined)
 const result=await f.client.admit(payload)
 assert.equal(result.ok,false);assert.equal(result.committed,true);assert.equal(result.generation,'committed-generation')
 assert.equal(result.detached,true);assert.equal(f.client.isCurrentResult(result),false)
 assert.deepEqual(f.client.pending(payload.operationId).imageReceipts,[ref])
})
test('late owner completion cannot clear or paint new-owner composer',async()=>{
 const deferred=wait();const f=setup(r=>r.operation==='admit'?deferred.promise:undefined)
 let cleared=0,painted=0,refused=0
 const pending=admitImageComposerIntent({client:f.client,draft:payload,revision:1,clearIfRevision:()=>cleared++,onQueued:()=>painted++,onRefused:()=>refused++})
 await tick();const request=f.calls.at(-1);f.detach()
 deferred.resolve({ok:true,operation:'admit',operationId:request.operationId,result:snapshot([{envelopeId:'new',text:payload.text,imageReceipts:[ref],selection:{model:'test-model',effort:null},state:'not-sent'}],'g')})
 assert.equal((await pending).ok,false);assert.equal(cleared,0);assert.equal(painted,0);assert.equal(refused,0)
})
test('older accepted draft cannot clear newer composer revision',async()=>{
 const deferred=wait();const f=setup(r=>r.operation==='admit'?deferred.promise:undefined)
 let revision=1,text=payload.text,painted=0
 const pending=admitImageComposerIntent({client:f.client,draft:payload,revision,clearIfRevision:r=>{if(r===revision)text=''},onQueued:()=>painted++})
 await tick();revision=2;text='new draft'
 const request=f.calls.at(-1)
 deferred.resolve({ok:true,operation:'admit',operationId:request.operationId,result:snapshot([{envelopeId:'new',text:payload.text,imageReceipts:[ref],selection:{model:'test-model',effort:null},state:'not-sent'}],'g')})
 assert.equal((await pending).ok,true);assert.equal(text,'new draft');assert.equal(painted,1)
})
test('requested model is durably bound; schema cannot silently discard selection',async()=>{
 const f=setup()
 const result=await f.client.admit({...payload,model:'requested-model',effort:'high'})
 assert.equal(result.ok,true);assert.deepEqual(result.entry.selection,{model:'requested-model',effort:'high'})
 assert.equal(f.client.pending(payload.operationId).intent.model,'requested-model')
})
test('incomplete snapshot and capacity refusal retain composer intent',async()=>{
 for(const code of ['IMAGE_OUTBOX_INCOMPLETE','IMAGE_OUTBOX_FULL']){
  const f=setup(r=>r.operation==='read'?{ok:true,operation:'read',operationId:null,result:{...snapshot(),writeBlocked:code}}:undefined)
  let clear=0
  const result=await admitImageComposerIntent({client:f.client,draft:payload,revision:1,clearIfRevision:()=>clear++})
  assert.equal(result.code,code);assert.equal(clear,0);assert.equal(f.calls.length,2)
 }
})

for (const variant of ['result', 'throw']) test('delayed '+variant+' owner refusal cannot invalidate successor authority', async()=>{
 const a=Object.freeze({...context,ownerId:'a'}),b=Object.freeze({...context,ownerId:'b',currentEpoch:'epoch-b'})
 let current=a,invalidations=0,resolve,reject
 const owner={capture:()=>current,isCurrent:value=>current===value,invalidate:()=>{invalidations++;current=null}}
 const client=createImageQueueClient({owner,sessionId:'session',bridge:{imageQueue:()=>new Promise((yes,no)=>{resolve=yes;reject=no})}})
 const pending=client.admit(payload);await tick();current=b
 if(variant==='result')resolve({ok:false,code:'IMAGE_OWNER_CHANGED',committed:true,generation:'old-generation',reconcile:true})
 else reject(Object.assign(new Error('changed'),{code:'IMAGE_OWNER_CHANGED'}))
 const result=await pending
 assert.equal(invalidations,0);assert.equal(current,b);assert.equal(result.detached,true)
 assert.equal(result.ownerContext,a);assert.equal(client.isCurrentResult(result),false)
})
for(const variant of ['success','refusal'])test('cached '+variant+' cannot publish after owner replacement',async()=>{
 const f=setup(r=>variant==='refusal'&&r.operation==='admit'?{ok:false,code:'IMAGE_OUTBOX_FULL'}:undefined)
 const first=await f.client.admit(payload);assert.equal(first.ok,variant==='success')
 const count=f.calls.length;f.detach();let queued=0,refused=0,cleared=0
 const cached=await admitImageComposerIntent({client:f.client,draft:payload,revision:1,onQueued:()=>queued++,onRefused:()=>refused++,clearIfRevision:()=>cleared++})
 assert.equal(cached.detached,true);assert.equal(queued,0);assert.equal(refused,0);assert.equal(cleared,0)
 assert.equal(f.calls.length,count)
})
test('onQueued owner change is rechecked before clearing composer',async()=>{
 const f=setup();let clears=0
 await admitImageComposerIntent({client:f.client,draft:payload,revision:1,onQueued:()=>f.detach(),clearIfRevision:()=>clears++})
 assert.equal(clears,0)
})

test('explicit null effort is retained and cannot be substituted; omitted selection is host-derived',async()=>{
 const explicit=setup();assert.equal((await explicit.client.admit({...payload,model:'test-model',effort:null})).ok,true)
 assert.deepEqual(explicit.calls.at(-1).selection,{model:'test-model',effort:null})
 const omitted=setup();await omitted.client.admit(payload);assert.equal(Object.hasOwn(omitted.calls.at(-1),'selection'),false)
 const mismatch=setup(r=>r.operation==='admit'?{ok:true,operation:'admit',operationId:r.operationId,result:snapshot([{envelopeId:'new',text:r.text,imageReceipts:r.imageReceipts,selection:{model:'test-model',effort:'high'},state:'not-sent'}],'g')}:undefined)
 assert.equal((await mismatch.client.admit({...payload,model:'test-model',effort:null})).code,'IMAGE_QUEUE_RECEIPT_INVALID')
})
test('queued publication exception preserves durable admission and same-operation outcome',async()=>{
 const f=setup();let cleared=0
 const result=await admitImageComposerIntent({client:f.client,draft:payload,revision:1,onQueued:()=>{throw Error('paint')},clearIfRevision:()=>cleared++})
 assert.equal(result.ok,true);assert.equal(result.publicationError,'IMAGE_QUEUE_PUBLICATION_FAILED');assert.equal(cleared,0)
 assert.equal((await f.client.admit(payload)).ok,true)
 assert.equal(f.calls.filter(r=>r.operation==='admit').length,1)
})
