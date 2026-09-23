import test from 'node:test'
import assert from 'node:assert/strict'
import {createImageConversation} from '../../src/image-conversation.js'

function fixture(mode='success') {
  let retired=false, live=true, notifyOwner=()=>{}
  let context={version:1,ownerId:'owner-a',currentEpoch:'epoch-a',kind:'local'}
  let destination='source', generation='generation-before'
  const calls=[],views=[]
  const entries=[{envelopeId:'row',text:'retained intent',imageReceipts:[],selection:{model:'m',effort:null},state:'not-sent'}]
  const snapshot=()=>({version:1,generation,destinationSessionId:destination,entries:structuredClone(entries),automaticSend:false})
  const bridge={
    ownerContext:async()=>context,
    onOwnerContextChanged:callback=>{notifyOwner=callback;return()=>{notifyOwner=()=>{}}},
    imageQueue:async request=>{
      calls.push(structuredClone(request))
      if(request.operation==='binding') {
        if(retired)throw Object.assign(Error('source retired'),{code:'MC_AGENT_UNKNOWN_SESSION'})
        return{ok:true,result:{sessionId:'source',conversationId:'conversation',ownerContext:context}}
      }
      if(request.operation==='transfer') {
        assert.equal(request.expectedGeneration,'generation-before')
        assert.equal(request.expectedDestinationSessionId,'source')
        retired=true;generation='generation-after'
        destination=mode==='wrong-destination'?'other':'successor'
        return{ok:true,operation:'transfer',operationId:request.operationId,result:{...snapshot(),destinationSessionId:'successor'}}
      }
      if(request.operation==='read') {
        if(retired&&mode==='read-failure')throw Object.assign(Error('read failed'),{code:'READ_FAILED'})
        if(retired&&mode==='owner-change') {
          context={...context,ownerId:'owner-b',currentEpoch:'epoch-b'}
          notifyOwner({version:1,invalidated:true})
        }
        if(retired&&mode==='disposed')live=false
        return{ok:true,operation:'read',operationId:null,result:snapshot()}
      }
      assert.fail('unexpected operation '+request.operation)
    },
  }
  const controller=createImageConversation({bridge,sessionId:'source',isCurrent:()=>live,mayDrain:()=>true,subscribeReady:()=>()=>{}})
  const unsubscribe=controller.subscribe(value=>views.push(value))
  return{controller,calls,views,async ready(){return controller.refresh()},dispose(){unsubscribe();controller.dispose()},
    changeOwner(){context={...context,ownerId:'owner-b',currentEpoch:'epoch-b'};notifyOwner({version:1,invalidated:true})}}
}
test('retired source reconciles committed successor with captured partition read, not another binding',async()=>{
 const f=fixture()
 try {
  const view=await f.ready()
  f.controller.hold()
  const result=await f.controller.transferDestination({destinationSessionId:'successor',view,operationId:'transfer-operation'})
  assert.equal(result.reconciled,true)
  assert.equal(result.currentSnapshot.destinationSessionId,'successor')
  const at=f.calls.findIndex(r=>r.operation==='transfer')
  assert.deepEqual(f.calls.slice(at).map(r=>r.operation),['transfer','read'])
  assert.equal(f.calls.at(-1).conversationId,'conversation')
  assert.equal(Object.hasOwn(f.calls.at(-1),'sessionId'),false)
  assert.equal(f.calls.some(r=>r.operation==='dispatch'),false)
 } finally {f.dispose()}
})
for(const mode of ['wrong-destination','read-failure','owner-change','disposed'])test('retired transfer '+mode+' never adopts historical success or dispatches',async()=>{
 const f=fixture(mode)
 try {
  const view=await f.ready();f.controller.hold()
  const result=await f.controller.transferDestination({destinationSessionId:'successor',view,operationId:'transfer-operation'})
  assert.notEqual(result.reconciled,true)
  assert.equal(f.calls.some(r=>r.operation==='dispatch'),false)
  if(mode==='wrong-destination'||mode==='read-failure') {
   assert.equal(f.views.at(-1).entries[0].text,'retained intent')
   assert.equal(f.views.at(-1).state,'held')
  }
 } finally {f.dispose()}
})
test('cached transfer success cannot publish as current after owner change',async()=>{
 const f=fixture()
 try {
  const view=await f.ready();f.controller.hold()
  const request={destinationSessionId:'successor',view,operationId:'transfer-operation'}
  assert.equal((await f.controller.transferDestination(request)).reconciled,true)
  f.changeOwner()
  assert.equal((await f.controller.transferDestination(request)).detached,true)
  assert.equal(f.calls.filter(r=>r.operation==='transfer').length,1)
 } finally {f.dispose()}
})
