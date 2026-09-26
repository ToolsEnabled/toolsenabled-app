import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createImageQueueClient } from '../../src/image-queue-client.js'

function fixture(){
 const context={version:1,ownerId:'owner',currentEpoch:randomUUID(),kind:'local'}
 let current=true,partition='conversation',code=null
 const owner={capture:()=>context,isCurrent:c=>current&&c===context,invalidate:()=>{current=false}}
 const ref={version:1,id:randomUUID(),slot:0,manifestHash:'a'.repeat(64),imageCount:2}
 const calls=[]
 const bridge={imageQueue:async r=>{
  calls.push(r)
  if(code)return{ok:false,code}
  const answer=result=>({ok:true,operation:r.operation,operationId:r.operationId||null,result})
  if(r.operation==='binding')return{ok:true,result:{sessionId:r.sessionId,conversationId:partition,ownerContext:context}}
  if(r.operation==='retain')return answer({...ref,state:'retained'})
  if(r.operation==='reopen')return answer({version:1,id:ref.id,conversationId:partition,state:'retained',automaticSend:false,images:[{index:0},{index:1}]})
  const snapshot={version:1,generation:null,entries:[],destinationSessionId:'successor',automaticSend:false}
  if(r.operation==='read')return answer(snapshot)
  if(r.operation==='admit')return answer({...snapshot,generation:randomUUID(),entries:[{envelopeId:randomUUID(),text:r.text,imageReceipts:r.imageReceipts,state:'not-sent',selection:{model:'model',effort:null}}]})
  assert.fail('unexpected operation '+r.operation)
 }}
 const client=sessionId=>createImageQueueClient({bridge,owner,sessionId})
 const draft={operationId:randomUUID(),draftId:randomUUID(),revision:4,text:'unsent\n  ',images:[{path:'first.png'},{path:'second.png'}]}
 return{client,draft,calls,context,setPartition:v=>partition=v,refuse:v=>code=v,invalidate:()=>current=false}
}
test('retain-only preserves immutable draft and never admits or dispatches; successor consumes same partition receipts',async()=>{
 const f=fixture(),source=f.client('source')
 const kept=await source.prepareRetainedImages(f.draft)
 assert.equal(kept.ok,true)
 assert.equal(Object.isFrozen(kept.retainedDraft),true)
 assert.equal(Object.isFrozen(kept.retainedDraft.imageReceipts[0]),true)
 assert.deepEqual(f.calls.map(r=>r.operation),['binding','retain','reopen'])
 assert.equal(kept.retainedDraft.draftId,f.draft.draftId)
 assert.equal(kept.retainedDraft.text,f.draft.text)
 const result=await f.client('successor').admit({...f.draft,operationId:randomUUID(),retainedDraft:kept.retainedDraft})
 assert.equal(result.ok,true)
 assert.deepEqual(f.calls.slice(3).map(r=>r.operation),['binding','read','reopen','admit'])
 assert.equal(f.calls.filter(r=>r.operation==='retain').length,1)
 assert.equal(f.calls.some(r=>r.operation==='dispatch'),false)
})
test('changed identity/revision and successor partition cannot consume retained draft',async()=>{
 const f=fixture(),kept=await f.client('source').prepareRetainedImages(f.draft)
 const next=f.client('successor'),before=f.calls.length
 for(const delta of [{draftId:randomUUID()},{revision:5},{text:'edited'}]){
  const result=await next.admit({...f.draft,...delta,operationId:randomUUID(),retainedDraft:kept.retainedDraft})
  assert.equal(result.code,'IMAGE_QUEUE_DRAFT_CHANGED')
 }
 assert.equal(f.calls.length,before)
 f.setPartition('different')
 const result=await next.admit({...f.draft,operationId:randomUUID(),retainedDraft:kept.retainedDraft})
 assert.equal(result.code,'IMAGE_CUSTODY_SCOPE')
 assert.equal(f.calls.some(r=>r.operation==='admit'),false)
 assert.equal(kept.retainedDraft.text,f.draft.text)
})
test('named re-pick refusal remains current and cached retention cannot publish across owner change',async()=>{
 const f=fixture(),source=f.client('source')
 f.refuse('IMAGE_CUSTODY_REPICK_REQUIRED')
 const refused=await source.prepareRetainedImages(f.draft)
 assert.equal(refused.code,'IMAGE_CUSTODY_REPICK_REQUIRED')
 assert.equal(source.isCurrentResult(refused),true)
 f.refuse(null)
 const draft={...f.draft,operationId:randomUUID()}
 assert.equal((await source.prepareRetainedImages(draft)).ok,true)
 f.invalidate()
 assert.equal((await source.prepareRetainedImages(draft)).ok,false)
 assert.equal(f.calls.some(r=>r.operation==='admit'||r.operation==='dispatch'),false)
})

test('edited text explicitly re-prepares existing receipts without old source paths or implicit admission',async()=>{
 const f=fixture(),kept=await f.client('source').prepareRetainedImages(f.draft)
 const next=f.client('successor')
 const edited={...f.draft,operationId:randomUUID(),draftId:randomUUID(),revision:0,text:'new text\n  ',retainedDraft:kept.retainedDraft}
 const before=f.calls.length
 const prepared=await next.prepareRetainedImages(edited)
 assert.equal(prepared.ok,true)
 assert.equal(prepared.retainedDraft.text,edited.text)
 assert.deepEqual(prepared.retainedDraft.imageReceipts,kept.retainedDraft.imageReceipts)
 assert.deepEqual(f.calls.slice(before).map(r=>r.operation),['binding','reopen'])
 assert.equal(kept.retainedDraft.text,f.draft.text)
 const sent=await next.admit({...edited,operationId:randomUUID(),retainedDraft:prepared.retainedDraft})
 assert.equal(sent.ok,true)
 assert.equal(sent.entry.text,edited.text)
 assert.equal(f.calls.filter(r=>r.operation==='retain').length,1)
})
