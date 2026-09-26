import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createImageQueueClient} from '../../src/image-queue-client.js'

// Execute the current production callback, not a reimplementation of its map.
const source=fs.readFileSync(new URL('../../src/views/computers.js',import.meta.url),'utf8')
const begin=source.indexOf('  function imageConversationFor(nodeId) {')
const end=source.indexOf('\n  function treeChatConfigFor(',begin)
assert.ok(begin>=0&&end>begin)
const callbackSource=source.slice(begin,end)
const mainSource=fs.readFileSync(new URL('../../shell/main.cjs',import.meta.url),'utf8')
const normalizerStart=mainSource.indexOf("  if (request.operation === 'admit') {")
const normalizerEnd=mainSource.indexOf('  const result = service.run(request, context)',normalizerStart)
assert.ok(normalizerStart>=0&&normalizerEnd>normalizerStart)
const normalize=new Function('request','sessionAuthority','agentIpcError',mainSource.slice(normalizerStart,normalizerEnd)+'\nreturn request')
test('computers model-only image intent retains authoritative nonnull effort',async()=>{
 const context={version:1,ownerId:'owner',currentEpoch:'epoch',kind:'local'}
 const session={model:'original-model',effort:'high'}
 const node={id:'node',sessionId:'session'},calls=[]
 const owner={capture:()=>context,isCurrent:c=>c===context,invalidate(){}}
 const snapshot=(entries=[],generation=null)=>({version:1,generation,entries,destinationSessionId:'session',automaticSend:false})
 const bridge={imageQueue:async request=>{
  calls.push(request)
  if(request.operation==='binding')return{ok:true,result:{sessionId:'session',conversationId:'conversation',ownerContext:context}}
  let result
  if(request.operation==='read')result=snapshot()
  if(request.operation==='retain')result={version:1,id:'receipt',slot:0,manifestHash:'a'.repeat(64),imageCount:1,state:'retained'}
  // Execute the current host normalization fragment with authenticated authority fixture.
  const normalized=normalize(structuredClone(request),()=>session,code=>{throw Error(code)})
  if(request.operation==='admit')result=snapshot([{envelopeId:'row',text:request.text,imageReceipts:request.imageReceipts,
   selection:normalized.selection,state:'not-sent'}],'generation')
  return{ok:true,operation:request.operation,operationId:request.operationId||null,result}
 }}
 const factory=({sessionId,isCurrent})=>({submit:draft=>createImageQueueClient({bridge,owner,sessionId,isCurrent}).admit(draft)})
 const make=new Function('treeStore','window','imageConversations','destroyed','createImageConversation','nodeBusy','registerNodeStatusListener','sessionModelOverride',
  'unsubs','nodeSessionEnded','nodeCleanupPending','nodeReplacementFlight',
  callbackSource+'\nreturn sendImageIntent')
 const send=make({getNode:()=>node},{mcAgent:bridge},new Map(),false,factory,()=>false,()=>()=>{},new Map([['session','requested-model']]),
  [],()=>false,()=>false,{busy:()=>false})
 const result=await send('node',{operationId:'operation',text:'',images:[{path:'issued.png'}]},()=>{})
 assert.equal(result.ok,true)
 assert.equal(result.entry.selection.model,'requested-model')
 assert.equal(result.entry.selection.effort,'high','model override must not fabricate null effort')
 assert.equal(calls.filter(r=>r.operation==='admit').length,1)
 assert.equal(Object.hasOwn(calls.find(r=>r.operation==='admit').selection,'effort'),false)
})
