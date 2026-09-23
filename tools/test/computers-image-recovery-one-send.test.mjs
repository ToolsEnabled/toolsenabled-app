import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createImageConversation } from '../../src/image-conversation.js'
import { functionSource } from './fixtures/recovery-outbox.mjs'
const dom=installDomStandIn()
const {buildChat}=await import('../../src/components.js')
const source=fs.readFileSync(new URL('../../src/views/computers.js',import.meta.url),'utf8')
const start=source.indexOf('  const imageConversations = new Map()')
const end=source.indexOf('  function treeChatConfigFor(node)',start)
assert.ok(start>=0&&end>start)
const body=source.slice(start,end)
const until=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(setImmediate);assert.ok(check())}
for(const scenario of ['accepted','image-only','unknown','newer-draft','owner-change','disposed']) test('ONE image Send hands durable completion and delivery callback to successor: '+scenario,async()=>{
 const ownerContext={version:1,ownerId:'owner',currentEpoch:randomUUID(),kind:'local'}
 const images=[{path:'red.png'},{path:'blue.png'}],text=scenario==='image-only'?'':'  exact\nintent  '
 const rowId=randomUUID(),ref={version:1,id:randomUUID(),slot:0,manifestHash:'a'.repeat(64),imageCount:2}
 let snapshot={version:1,generation:null,entries:[],destinationSessionId:null,automaticSend:false}
 const calls=[],listeners=new Set(),ownerListeners=new Set(),unsubs=[]
 let activeOwner=ownerContext
 const node={id:'node',sessionId:'source',ended:true,busy:false}
 const store={getNode:()=>node}
 let startObserved,releaseResume,bindObserved,releaseBind,dispatchObserved,resumedObserved,returnObserved
 const returned=new Promise(r=>returnObserved=r)
 const resumed=new Promise(r=>resumedObserved=r)
 const starting=new Promise(r=>startObserved=r),resumeGate=new Promise(r=>releaseResume=r)
 const binding=new Promise(r=>bindObserved=r),bindGate=new Promise(r=>releaseBind=r)
 const dispatched=new Promise(r=>dispatchObserved=r)
 const bridge={ownerContext:async()=>activeOwner,onOwnerContextChanged:listener=>{ownerListeners.add(listener);return()=>ownerListeners.delete(listener)},imageQueue:async r=>{
  calls.push(r)
  const answer=result=>({ok:true,operation:r.operation,operationId:r.operationId||null,result})
  if(r.operation==='binding'){
   if(r.sessionId==='successor'){bindObserved();await bindGate}
   return{ok:true,result:{sessionId:r.sessionId,conversationId:'conversation',ownerContext}}
  }
  if(r.operation==='read')return answer(structuredClone(snapshot))
  if(r.operation==='retain')return answer({...ref,state:'retained'})
  if(r.operation==='admit'){
   assert.equal(r.expectedGeneration,snapshot.generation)
   snapshot={...snapshot,generation:randomUUID(),entries:[{envelopeId:rowId,text:r.text,imageReceipts:r.imageReceipts,state:'not-sent',selection:{model:'chosen',effort:'high'}}]}
   return answer(structuredClone(snapshot))
  }
  if(r.operation==='transfer'){
   assert.equal(r.expectedGeneration,snapshot.generation)
   assert.equal(r.expectedDestinationSessionId,snapshot.destinationSessionId)
   snapshot={...snapshot,generation:randomUUID(),destinationSessionId:r.destinationSessionId}
   return answer(structuredClone(snapshot))
  }
  if(r.operation==='dispatch'){
   assert.equal(node.busy,false);assert.equal(node.ended,false)
   assert.equal(r.sessionId,'successor');assert.equal(r.expectedGeneration,snapshot.generation)
   assert.equal(snapshot.entries[0].text,text)
   assert.deepEqual(snapshot.entries[0].imageReceipts,[ref])
   assert.deepEqual(snapshot.entries[0].selection,{model:'chosen',effort:'high'})
   snapshot={...snapshot,generation:randomUUID(),entries:snapshot.entries.map(row=>({...row,state:scenario==='unknown'?'unknown':'accepted'}))}
   dispatchObserved()
   return{...answer(structuredClone(snapshot)),conversationId:r.conversationId,sessionId:r.sessionId,envelopeId:r.envelopeId,
    ownerContext,deliveryDisposition:scenario==='unknown'?'unknown':'accepted',attemptId:randomUUID(),reconcile:scenario==='unknown'}
  }
  assert.fail('unexpected '+r.operation)
 }}
 const prior=globalThis.window
 globalThis.window={mcAgent:bridge}
 const pendingModelChoices=new Map(),pendingModelDrainHolds=new Set()
 const pendingModelChoice=new Function('pendingModelChoices','notifyNodeStatusListeners',
  functionSource('cancelPendingModelChoice')+'\n'+functionSource('pendingModelChoice')+'\nreturn pendingModelChoice')(pendingModelChoices,()=>{})
 const args={treeStore:store,window:globalThis.window,unsubs,createImageConversation,pendingModelChoice,pendingModelDrainHolds,
  nodeBusy:n=>n.busy,nodeSessionEnded:n=>n.ended,nodeCleanupPending:()=>false,nodeReplacementFlight:{busy:()=>false},
  registerNodeStatusListener:(_id,fn)=>{listeners.add(fn);return()=>listeners.delete(fn)},
  sessionModelOverride:new Map([['source','chosen']]),
  resumeNodeSession:async(_node,options)=>{assert.equal(options.deliverQueued,false);assert.equal(options.deferSeed,true);startObserved();await resumeGate;node.sessionId='successor';node.ended=false;node.busy=true;resumedObserved();return true}}
 const factory=new Function(...Object.keys(args),'let destroyed=false;\n'+body+'\nreturn {sendImageIntent,imageConversationFor}')
 const api=factory(...Object.values(args))
 const chat=buildChat({seed:0,chips:{},
  onSend:()=>{assert.fail('Image intent reached the ordinary text sender')},
  onImageIntent:async(draft,state)=>{
   try { const result=await api.sendImageIntent('node',draft,state);returnObserved({result});return result }
   catch(error){returnObserved({error});throw error}
  }})
 dom.document.body.appendChild(chat)
 try{
  chat.importDraft({text,attachments:images})
  const sendButton=chat.querySelector('.chat-send')
  assert.ok(sendButton,'production Send button is mounted')
  assert.equal(sendButton.disabled,false,'fixture wires a production-shaped sender')
  sendButton.click()
  const first=await Promise.race([
   starting.then(()=>({phase:'resume-started'})),
   returned.then(completion=>({phase:'callback-completed',completion})),
  ])
  assert.equal(first.phase,'resume-started',
   'Image callback completed before resume: '+JSON.stringify(first.completion))

  assert.equal(calls.some(r=>r.operation==='dispatch'),false)
  assert.equal(snapshot.entries[0].text,text)
  if(scenario==='newer-draft')chat.importDraft({text:'newer text  ',attachments:[images[1]]})
  if(scenario==='disposed')chat.dispose()
  if(scenario==='owner-change'){
   activeOwner={...ownerContext,currentEpoch:randomUUID()}
   for(const notify of [...ownerListeners])notify({version:1,invalidated:true})
  }
  releaseResume()
  await resumed
  const callback=await returned
  assert.equal(callback.error,undefined,'image callback must not throw')
  const completion=callback.result
  assert.equal(node.busy,true,'successor stays busy through original callback completion')
  assert.equal(calls.some(r=>r.operation==='dispatch'),false)
  if(scenario==='owner-change'){
   assert.equal(Boolean(completion.isCurrent()),false)
   node.busy=false
   releaseBind()
   for(const notify of [...listeners])notify()
   await api.imageConversationFor('node').refresh()
   assert.equal(calls.filter(r=>r.operation==='dispatch').length,0)
   assert.equal(chat.exportDraft().text,text)
   assert.deepEqual(chat.exportDraft().attachments,images)
   assert.equal(chat.querySelector('.chat-image-intent-summary'),null)
   return
  }
  if(scenario!=='disposed'){
   await until(()=>Boolean(chat.querySelector('.chat-image-intent-summary')))
   assert.equal(chat.querySelector('.me').dataset.deliveryState,'queued')
   assert.equal(chat.exportDraft().text,scenario==='newer-draft'?'newer text  ':'')
   assert.deepEqual(chat.exportDraft().attachments,scenario==='newer-draft'?[images[1]]:[])
  }
  node.busy=false
  for(const notify of [...listeners])notify()
  await binding
  assert.equal(calls.some(r=>r.operation==='dispatch'),false)
  releaseBind();await dispatched
  if(scenario==='disposed'){
   await api.imageConversationFor('node').signalReady()
   assert.equal(chat.querySelector('.chat-image-intent-summary'),null)
   assert.equal(chat.exportDraft().text,text)
  }else{
   await until(()=>chat.querySelector('.me')?.dataset.deliveryState===(scenario==='unknown'?'unknown':'accepted'))
   if(scenario==='newer-draft')assert.equal(chat.exportDraft().text,'newer text  ')
  }
  for(const notify of [...listeners])notify()
  await api.imageConversationFor('node').signalReady()
  assert.equal(calls.filter(r=>r.operation==='dispatch').length,1)
  assert.equal(calls.filter(r=>r.operation==='admit').length,1)
  assert.deepEqual(calls.find(r=>r.operation==='retain').images,images)
 }finally{releaseResume();releaseBind();chat.dispose();for(const dispose of unsubs)dispose();globalThis.window=prior}
})
test.after(()=>dom.restore())
