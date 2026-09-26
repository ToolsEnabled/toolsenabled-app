import test from 'node:test'
import assert from 'node:assert/strict'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
test('missing transcript bind capability rejects instead of claiming readiness',async()=>{
 const client=createNodeTranscriptClient({computerId:'computer',bridge:{list:async()=>({ok:true,records:[]})}})
 try{await client.ready;await assert.rejects(client.bind('session','node'),{code:'TRANSCRIPT_BIND_UNAVAILABLE'})}
 finally{client.dispose()}
})
test('existing transcript bind awaits and preserves real receipt; refusal rejects',async()=>{
 let answer,release
 const gate=new Promise(r=>release=r),calls=[]
 const bridge={list:async()=>({ok:true,records:[]}),bind:async request=>{calls.push(request);await gate;return answer}}
 const client=createNodeTranscriptClient({computerId:'computer',bridge})
 try{
  await client.ready;let settled=false
  const pending=client.bind('session','node').then(value=>{settled=true;return value})
  await Promise.resolve();assert.equal(settled,false)
  answer={ok:true};release()
  assert.equal(await pending,answer)
  assert.deepEqual(calls,[{sessionId:'session',computerId:'computer',nodeId:'node'}])
  answer={ok:false,error:{code:'TRANSCRIPT_BIND_REFUSED',message:'Binding refused'}}
  await assert.rejects(client.bind('session','node'),{code:'TRANSCRIPT_BIND_REFUSED',message:'Binding refused'})
 }finally{release();client.dispose()}
})

test('truthy or absent ok never confirms transcript readiness',async()=>{
 let answer
 const client=createNodeTranscriptClient({computerId:'computer',bridge:{list:async()=>({ok:true,records:[]}),bind:async()=>answer}})
 try{
  await client.ready
  for(answer of [{ok:1},{ok:'true'},{},null]){
   await assert.rejects(client.bind('session','node'),/did not confirm/)
  }
  answer={ok:false,error:{code:'unvalidated code',message:'Refusal message'}}
  await assert.rejects(client.bind('session','node'),error=>error.message==='Refusal message'&&error.code===undefined)
 }finally{client.dispose()}
})
for(const change of ['superseded','released','disposed'])test('pending bind completion fenced after '+change,async()=>{
 let entered,release,calls=0
 const invoked=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 const client=createNodeTranscriptClient({computerId:'computer',bridge:{
  list:async()=>({ok:true,records:[]}),
  bind:async()=>{if(++calls===1){entered();await gate}return{ok:true}},
  release:async()=>({ok:true}),
 }})
 try{
  await client.ready
  const first=client.bind('session','old-node')
  const refused=assert.rejects(first,{code:'TRANSCRIPT_BIND_STALE'})
  await invoked
  if(change==='superseded')assert.deepEqual(await client.bind('session','new-node'),{ok:true})
  else if(change==='released')await client.release('session')
  else client.dispose()
  release();await refused
 }finally{release();client.dispose()}
})
