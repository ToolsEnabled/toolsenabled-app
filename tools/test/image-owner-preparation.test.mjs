import test from 'node:test'
import assert from 'node:assert/strict'
import {createImageOwnerClient} from '../../src/image-owner-client.js'
import {createImageConversation} from '../../src/image-conversation.js'

function fixture() {
 let current={version:1,ownerId:'local-owner',currentEpoch:'first',kind:'local'}
 let listener=()=>{},subscriptions=0,removed=0,reads=0
 const bridge={
  ownerContext:async()=>{reads++;return current},
  onOwnerContextChanged:callback=>{subscriptions++;listener=callback;return()=>{removed++;listener=()=>{}}},
  imageQueue:async request=>request.operation==='binding'
   ?{ok:true,result:{conversationId:'conversation',sessionId:request.sessionId,ownerContext:request.ownerContext}}
   :{ok:true,operation:'read',operationId:null,result:{version:1,generation:null,entries:[],destinationSessionId:'new-session',automaticSend:false}},
 }
 const owner=createImageOwnerClient({bridge})
 return{bridge,owner,counts:()=>({subscriptions,removed,reads}),switchOwner(){current={version:1,ownerId:'account-owner',currentEpoch:'second',kind:'account'};listener({version:1,invalidated:true})}}
}
test('pre-session preparation and mounted successor share one owner subscription',async()=>{
 const f=fixture();let conversation
 try {
  const prepared=await f.owner.prepareImages(async authority=>{
   assert.equal(authority.isCurrent(),true)
   return{sessionId:'new-session',images:[{path:'issued.png'}]}
  })
  assert.equal(prepared.ok,true)
  conversation=createImageConversation({bridge:f.bridge,ownerClient:f.owner,sessionId:prepared.value.sessionId,
   isCurrent:()=>true,mayDrain:()=>false,subscribeReady:()=>()=>{}})
  await conversation.refresh()
  assert.equal(f.counts().subscriptions,1)
  assert.equal(f.counts().reads,1)
  conversation.dispose()
  assert.equal(f.counts().removed,0)
  assert.equal(prepared.isCurrent(),true)
 } finally {conversation?.dispose();f.owner.dispose()}
 assert.equal(f.counts().removed,1)
})
test('owner transition after start-only prevents remaining paste preparation and publication',async()=>{
 const f=fixture();let continueStart,started,preparedPaths=0
 const startGate=new Promise(r=>continueStart=r)
 const atStart=new Promise(r=>started=r)
 try {
  const pending=f.owner.prepareImages(async authority=>{
   started();await startGate
   if(!authority.isCurrent())return null
   preparedPaths++
   return[{path:'issued.png'}]
  })
  await atStart;f.switchOwner();continueStart()
  const result=await pending
  assert.equal(result.ok,false);assert.equal(result.detached,true)
  assert.equal(preparedPaths,0)
 } finally {continueStart();f.owner.dispose()}
})
test('prepared result becomes stale immediately on invalidation and disposal',async()=>{
 const f=fixture()
 const prepared=await f.owner.prepareImages(async()=>[{path:'issued.png'}])
 assert.equal(prepared.isCurrent(),true)
 f.switchOwner();assert.equal(prepared.isCurrent(),false)
 f.owner.dispose();assert.equal(prepared.isCurrent(),false)
})
