import test from 'node:test'
import assert from 'node:assert/strict'
import {createImageQueueDrain} from '../../src/image-queue-drain.js'
const tick=()=>new Promise(r=>setTimeout(r,0))
const context={version:1,ownerId:'a',currentEpoch:'epoch-a',kind:'local'}
function fixture(dispatch,extra={}){
 let current=context,ready=true,serial=0
 const calls=[],states=[]
 const owner={isCurrent:value=>value===current,invalidate:()=>{current=null}}
 const bridge={imageQueue:async r=>{
  calls.push(r)
  if(r.operation==='read')return{ok:true,operation:'read',result:{version:1,generation:'generation',destinationSessionId:'s',entries:[{envelopeId:'envelope',state:extra.entryState||'not-sent'}]}}
  const value=await dispatch(r)
  const response={...r,attemptId:'attempt',automaticSend:false,...value}
  if (typeof extra.omitAttemptId === 'function' ? extra.omitAttemptId(r, value) : extra.omitAttemptId) delete response.attemptId
  return response
 }}
 const drain=createImageQueueDrain({bridge,owner,ownerContext:context,sessionId:'s',conversationId:'conversation',
  mayDrain:()=>ready,onState:state=>{states.push(state);extra.onState?.(state)},newOperationId:()=>String(++serial)})
 return{drain,calls,states,switchOwner:()=>{current={...context,ownerId:'b',currentEpoch:'b'}},setReady:value=>{ready=value}}
}
test('accepted plus terminal persistence failure remains accepted and cannot replay',async()=>{
 const f=fixture(async()=>({ok:false,deliveryDisposition:'accepted',reconcile:true,code:'IMAGE_OUTBOX_STALE'}))
 assert.equal((await f.drain.drain()).state,'accepted')
 assert.equal((await f.drain.drain()).state,'accepted')
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
})
test('unknown remains pinned even if stale read presents not-sent',async()=>{
 const f=fixture(async()=>({ok:false,deliveryDisposition:'unknown',reconcile:true}))
 assert.equal((await f.drain.drain()).state,'unknown');await f.drain.drain()
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
})
test('unknown durable entry is never dispatched',async()=>{
 const f=fixture(()=>assert.fail('must not dispatch'),{entryState:'unknown'})
 assert.equal((await f.drain.drain()).state,'unknown');assert.equal(f.calls.length,1)
})
test('attempted terminal not-sent receipt stays retained until an explicit authorized retry',async()=>{
 let tries=0
 const f=fixture(async()=>++tries===1?{ok:false,deliveryDisposition:'not-sent',dispatchStarted:false,retryable:false,code:'IMAGE_OUTBOX_DESTINATION_STALE',reconcile:false,result:{entries:[{envelopeId:'envelope',state:'not-sent',failure:{code:'IMAGE_OUTBOX_DESTINATION_STALE',retryable:false}}]}}
 :{ok:true,deliveryDisposition:'accepted',reconcile:false})
 const first=await f.drain.drain()
 assert.equal(first.state,'not-sent')
 assert.equal(first.attemptId,'attempt')
 assert.equal((await f.drain.drain()).state,'not-sent')
 assert.equal((await f.drain.retry('envelope')).state,'accepted')
 assert.deepEqual(f.calls.map(r=>r.operation),['read','dispatch','read','read','dispatch'])
 assert.notEqual(f.calls[1].operationId,f.calls[4].operationId)
})

test('no-attempt terminal refusal stays retained through reads and idle until one explicit retry',async()=>{
 let tries=0
 let omitFirstAttempt=true
 const failure={code:'IMAGE_OUTBOX_DESTINATION_STALE',retryable:false}
 const f=fixture(async()=>++tries===1?{ok:false,deliveryDisposition:'not-sent',dispatchStarted:false,retryable:false,code:failure.code,reconcile:false,result:{entries:[{envelopeId:'envelope',state:'not-sent',failure}]}}
 :{ok:true,deliveryDisposition:'accepted',reconcile:false},
 {omitAttemptId:()=>omitFirstAttempt})
 const first=await f.drain.drain()
 assert.equal(first.state,'not-sent')
 assert.equal(first.dispatchStarted,false)
 assert.equal(first.attemptId,undefined)
 assert.deepEqual(first.failure,failure)
 assert.equal((await f.drain.drain()).state,'not-sent')
 assert.deepEqual(f.drain.outcome('envelope').failure,failure)
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
 f.setReady(false)
 assert.equal((await f.drain.drain()).state,'held')
 assert.deepEqual(f.drain.outcome('envelope').failure,failure)
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
 f.setReady(true)
 const retained=await f.drain.drain()
 assert.equal(retained.state,'not-sent')
 assert.equal(retained.attemptId,undefined)
 omitFirstAttempt=false
 const retried=await f.drain.retry('envelope')
 assert.equal(retried.state,'accepted')
 assert.equal(tries,2)
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,2)
 assert.equal((await f.drain.drain()).state,'accepted')
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,2)
})
test('late accepted after owner switch keeps old fact without new-owner publication',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r))
 const pending=f.drain.drain();await tick();f.switchOwner()
 resolve({ok:false,deliveryDisposition:'accepted',reconcile:true})
 const result=await pending
 assert.equal(result.state,'accepted');assert.equal(result.detached,true);assert.equal(f.states.length,0)
 assert.equal(f.drain.outcome('envelope').state,'accepted')
})
test('publication exception cannot turn accepted receipt into replay eligibility',async()=>{
 const f=fixture(async()=>({ok:true,deliveryDisposition:'accepted',reconcile:false}),{onState:()=>{throw Error('render')}})
 const result=await f.drain.drain()
 assert.equal(result.state,'accepted');assert.equal(result.publicationError,'IMAGE_QUEUE_PUBLICATION_FAILED')
 await f.drain.drain();assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
})
test('mismatched dispatch receipt identity never acknowledges this envelope',async()=>{
 const f=fixture(async()=>({ok:true,deliveryDisposition:'accepted',sessionId:'replacement'}))
 assert.equal((await f.drain.drain()).state,'unknown')
})
