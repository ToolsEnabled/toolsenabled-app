import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageDraftClient } from '../../src/image-draft-client.js'
import { createImageQueueClient } from '../../src/image-queue-client.js'
function fixture() {
 const context={version:1,ownerId:'owner',currentEpoch:'epoch',kind:'local'}
 let current=context
 const owner={capture:()=>current,isCurrent:value=>value===current,invalidate:()=>{current=null},
  prepareImages:async fn=>{const captured=current;const value=await fn({ownerContext:captured});return current===captured?{ok:true,value}:{ok:false,detached:true}}}
 const grant={draftId:'host-draft',sessionId:'host-session',computerId:'actual-computer',conversationId:'actual-node',ownerContext:context}
 const ref={version:1,id:'receipt',slot:0,manifestHash:'a'.repeat(64),imageCount:2,state:'retained'}
 const calls=[];let count=0,adopted=false
 let snapshot={version:1,generation:null,destinationSessionId:null,entries:[],automaticSend:false}
 const bridge={imageQueue:async request=>{
  calls.push(structuredClone(request))
  const reply=(operation,result)=>({ok:true,operation,operationId:request.operationId||null,result})
  switch(request.operation){
   case 'draft-register':return reply(request.operation,grant)
   case 'draft-paste':return reply(request.operation,{draftId:grant.draftId,imageId:'opaque-'+(++count)})
   case 'draft-adopt':
    assert.equal(request.sessionId,grant.sessionId);adopted=true
    return reply(request.operation,{...grant,imageIds:request.imageIds,automaticSend:false})
   case 'binding':
    assert.equal(adopted,true,'host adoption must establish binding first')
    return {ok:true,result:{sessionId:grant.sessionId,conversationId:grant.conversationId,ownerContext:context}}
   case 'read':return reply(request.operation,structuredClone(snapshot))
   case 'draft-retain':
    assert.deepEqual(request.imageIds,['opaque-1','opaque-2'])
    assert.equal(Object.hasOwn(request,'images'),false)
    return reply('retain',ref)
   case 'admit':
    assert.equal(request.text,'')
    assert.equal(Object.hasOwn(request.selection,'effort'),false)
    snapshot={...snapshot,generation:'generation-1',entries:[{envelopeId:'envelope',text:request.text,
     imageReceipts:request.imageReceipts,state:'not-sent',selection:{model:'model',effort:'high'}}]}
    return reply(request.operation,structuredClone(snapshot))
   default:assert.fail('unexpected '+request.operation)
  }
 }}
 return {context,owner,grant,calls,bridge,changeOwner(){current={...context,currentEpoch:'new'}}}
}
test('host grant preserves minted start identity and original image-only admission without paths',async()=>{
 const f=fixture()
 const draft=createImageDraftClient({bridge:f.bridge,owner:f.owner,kind:'standalone',computerId:'actual-computer',nodeId:'actual-node'})
 const a=await draft.paste({mime:'image/png',data:'red-bytes'}),b=await draft.paste({mime:'image/png',data:'blue-bytes'})
 assert.deepEqual(draft.startIdentity(),{sessionId:'host-session',draftId:'host-draft',ownerContext:f.context})
 assert.equal(f.calls.filter(r=>r.operation==='draft-register').length,1)
 const hostDraft=draft.capture([a.result.imageId,b.result.imageId])
 assert.equal(Object.isFrozen(hostDraft),true)
 assert.equal(draft.capture(['invented']),null)
 const client=createImageQueueClient({bridge:f.bridge,owner:f.owner,sessionId:'host-session',newOperationId:()=> 'retain-operation'})
 const intent={operationId:'original-send',text:'',images:[],hostDraft,model:'model'}
 const result=await client.admit(intent)
 assert.equal(result.ok,true)
 assert.equal(result.entry.selection.effort,'high')
 assert.equal((await client.admit(intent)).ok,true)
 assert.equal(f.calls.filter(r=>r.operation==='admit').length,1)
 assert.equal(f.calls.filter(r=>r.operation==='draft-adopt').length,1)
 assert.equal(f.calls.some(r=>r.operation==='dispatch'||r.operation==='retain'),false)
 assert.equal(f.calls.find(r=>r.operation==='admit').operationId,'original-send')
 draft.dispose()
})
test('owner change fences captured grant and never invalidates a new owner from late paste refusal',async()=>{
 const f=fixture()
 const original=f.bridge.imageQueue;let finish
 f.bridge.imageQueue=request=>request.operation==='draft-paste'
  ? new Promise(resolve=>{finish=resolve}):original(request)
 const draft=createImageDraftClient({bridge:f.bridge,owner:f.owner,kind:'standalone',computerId:'actual-computer',nodeId:'actual-node'})
 await draft.register()
 const pending=draft.paste({mime:'image/png',data:'bytes'})
 // register is already settled; allow the actual paste request to be issued.
 await Promise.resolve();await Promise.resolve()
 assert.equal(typeof finish,'function')
 f.changeOwner();const next=f.owner.capture()
 finish({ok:false,code:'IMAGE_OWNER_CHANGED'})
 assert.equal((await pending).detached,true)
 assert.equal(f.owner.capture(),next)
 assert.equal(draft.startIdentity(),null)
 assert.equal(draft.capture(['opaque-1']),null)
})
test('host draft cannot mix guessed paths with opaque IDs or adopt for a different session',async()=>{
 const f=fixture()
 const client=createImageQueueClient({bridge:f.bridge,owner:f.owner,sessionId:'host-session'})
 const grant={...f.grant,imageIds:['opaque-1']}
 assert.equal((await client.admit({text:'',images:[{path:'invented.png'}],hostDraft:grant})).ok,false)
 assert.equal((await client.admit({text:'',hostDraft:{...grant,sessionId:'different'}})).ok,false)
 assert.equal(f.calls.length,0)
})
