import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createImageConversation } from '../../src/image-conversation.js'
const require=createRequire(import.meta.url)
const {createImageRetentionService}=require('../../shell/image-retention-service.cjs')
const dom=installDomStandIn()
const {buildChat}=await import('../../src/components.js')
const tick=()=>new Promise(r=>setTimeout(r,5))
const digest=b=>createHash('sha256').update(b).digest('hex')
const temp='C:/Users/ToolsEnabled-Dev/AppData/Local/Temp'
function fixture(busyInitially=false,options={}){
 const root=path.join(temp,'t489-composer-durable-'+randomUUID())
 fs.mkdirSync(root);assert.ok(fs.realpathSync(root).replaceAll('\\','/').startsWith('C:/Users/ToolsEnabled-Dev/'))
 const pngs=['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg=='].map(s=>Buffer.from(s,'base64'))
 const png=pngs[0]
 const paths=[path.join(root,'one.png'),path.join(root,'two.png')]
 paths.forEach((p,i)=>fs.writeFileSync(p,pngs[i]))
 console.log('PNG_FIXTURE '+JSON.stringify({root,images:paths.map(p=>({path:p,sha256:digest(fs.readFileSync(p)),bytes:fs.statSync(p).size}))}))
 const ownerContext=Object.freeze({version:1,ownerId:'fixture-owner',currentEpoch:randomUUID(),kind:'local'})
 const session={},issued=new Set(paths),calls=[],sent=[]
 let busy=busyInitially,notify=()=>{}
 const authority=()=>({session,sessionId:'session',accountId:'default',provider:'codex',model:'test-model',effort:null,issued})
 const service=createImageRetentionService({root:path.join(root,'store'),authenticate:c=>{
  assert.deepEqual(c,ownerContext);return{authenticated:true,productOwnerId:ownerContext.ownerId,currentEpoch:ownerContext.currentEpoch}
 },sourceAuthority:authority,candidateAuthority:authority,authorizeTransfer:()=>true,engineImageBytes:8*1024*1024})
 const bridge={
  ownerContext:async()=>ownerContext,onOwnerContextChanged:()=>()=>{},
  imageQueue:async request=>{
   calls.push(request)
   if(request.operation==='admit')await options.beforeAdmit?.(request)
   if(request.operation==='binding')return{ok:true,result:{conversationId:'conversation',sessionId:'session',ownerContext}}
   if(request.operation==='dispatch')return service.dispatch(request,request.ownerContext,async turn=>{
    sent.push({...turn,bytes:turn.images.map(image=>digest(fs.readFileSync(image.path)))})
    if(options.conflictAfterSend){const current=service.run({operation:'read',conversationId:'conversation'},ownerContext).result;const written=service.run({operation:'write',conversationId:'conversation',operationId:randomUUID(),expectedGeneration:current.generation,entries:current.entries},ownerContext);assert.equal(written.ok,true)}
    return{ok:true,deliveryDisposition:'accepted',result:{turnId:'turn-'+sent.length}}
   }).then(result=>({...result,operation:'dispatch',operationId:request.operationId,sessionId:request.sessionId,conversationId:request.conversationId,envelopeId:request.envelopeId,ownerContext}))
   return service.run(request.operation==='admit'&&!request.selection?{...request,selection:{model:'test-model',effort:null}}:request,request.ownerContext)
  },
 }
 const conversation=createImageConversation({bridge,sessionId:'session',isCurrent:()=>true,mayDrain:()=>!busy,
  subscribeReady:listener=>{notify=listener;return()=>{}},interrupt:async()=>{busy=false;notify()}})
 const chat=buildChat({seed:0,chips:{},imageOutbox:conversation,status:{busy:()=>busy},onSend:()=>assert.fail('legacy send must not bypass durable path'),
  onImageIntent:async(draft,state)=>{const result=await conversation.submit(draft,state);options.onAdmissionReturn?.(result);return result}})
 dom.document.body.appendChild(chat)
 return{chat,paths,sent,calls,root,png,pngs,bridge,service,ownerContext,conversation,release(){busy=false;notify()},read:()=>service.run({operation:'read',conversationId:'conversation'},ownerContext).result}
}
async function until(check){for(let i=0;i<80&&!check();i++)await tick();assert.ok(check())}
for(const text of ['', '  exact\nimage text  '])test('production composer to real durable admission/dispatch: '+JSON.stringify(text),async()=>{
 const f=fixture()
 try{
 f.chat.importDraft({text,attachments:f.paths.map(path=>({path,name:path,size:f.png.length}))})
 f.chat.querySelector('.chat-send').click()
 await until(()=>f.sent.length===1&&f.chat.exportDraft().attachments.length===0)
 assert.equal(f.sent[0].text,text)
 assert.deepEqual(f.sent[0].bytes,f.pngs.map(digest))
 assert.equal(f.sent[0].images.length,2)
 assert.equal(f.read().entries[0].state,'accepted')
 assert.equal(f.chat.exportDraft().attachments.length,0)
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
 assert.equal(f.chat.querySelector('.chat-image-intent-summary').textContent.includes('2 image(s)'),true)
 }finally{f.chat.dispose();f.conversation.dispose()}
})
test('busy durable image admission resumes at first ready notification without second click',async()=>{
 const f=fixture(true)
 try{
 f.chat.importDraft({text:'queued',attachments:f.paths.map(path=>({path}))})
 f.chat.querySelector('.chat-send').click()
 await until(()=>f.read().entries.length===1&&f.chat.exportDraft().attachments.length===0)
 assert.equal(f.sent.length,0);assert.equal(f.read().entries[0].state,'not-sent')
 f.release();await until(()=>f.sent.length===1)
 f.release();await tick();assert.equal(f.sent.length,1)
 assert.equal(f.read().entries[0].state,'accepted')
 }finally{f.chat.dispose();f.conversation.dispose()}
})

test('durable ACK clears only its captured composer revision',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),atAdmit=new Promise(r=>entered=r)
 const f=fixture(false,{beforeAdmit:async()=>{entered();await gate}})
 try{
 const original={text:'old\ntext  ',attachments:f.paths.map(path=>({path}))}
 f.chat.importDraft(original);f.chat.querySelector('.chat-send').click()
 await atAdmit;assert.deepEqual(f.chat.exportDraft().attachments,original.attachments);assert.equal(f.chat.exportDraft().text,original.text)
 f.chat.importDraft({text:'new draft  ',attachments:[original.attachments[1]]})
 release();await until(()=>Boolean(f.chat.querySelector('.chat-image-intent-summary')))
 assert.equal(f.chat.exportDraft().text,'new draft  ');assert.deepEqual(f.chat.exportDraft().attachments,[original.attachments[1]])
 await until(()=>f.sent.length===1);assert.equal(f.sent[0].text,original.text)
 }finally{release();f.chat.dispose();f.conversation.dispose()}
})
test('owner-row render exception after durable admission retains fact and same-operation retry never redispatches',async()=>{
 const create=dom.document.createElement.bind(dom.document);let injected=false
 const f=fixture(false,{onAdmissionReturn:()=>{if(injected)return;injected=true;let once=true
 dom.document.createElement=(...args)=>{if(once){once=false;throw Error('injected row render failure')}return create(...args)}
 }})
 try{
 f.chat.importDraft({text:'',attachments:f.paths.map(path=>({path}))});f.chat.querySelector('.chat-send').click()
 await until(()=>f.chat.textContent.includes('Their display could not update'))
 await until(()=>f.read().entries[0]?.state==='accepted')
 assert.equal(f.sent.length,1);assert.equal(f.chat.exportDraft().attachments.length,2)
 assert.equal(f.chat.textContent.includes('admission unconfirmed'),false)
 f.chat.querySelector('.chat-send').click()
 await until(()=>f.chat.exportDraft().attachments.length===0)
 assert.equal(f.calls.filter(r=>r.operation==='admit').length,1)
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
 assert.equal(f.read().entries[0].state,'accepted')
 }finally{dom.document.createElement=create;f.chat.dispose();f.conversation.dispose()}
})


test('accepted dispatch with terminal CAS failure is visible accepted and cannot replay',async()=>{
 const f=fixture(false,{conflictAfterSend:true})
 try{
 f.chat.importDraft({text:'accepted despite storage conflict',attachments:f.paths.map(path=>({path}))})
 f.chat.querySelector('.chat-send').click()
 await until(()=>f.chat.querySelector('.me')?.dataset.deliveryState==='accepted')
 assert.equal(f.chat.exportDraft().attachments.length,0)
 assert.equal(f.read().entries[0].state,'unknown')
 assert.equal(f.sent.length,1);f.release()
 await until(()=>f.calls.filter(r=>r.operation==='read').length>=3)
 assert.equal(f.calls.filter(r=>r.operation==='dispatch').length,1)
 }finally{f.chat.dispose();f.conversation.dispose()}
})


test('reopened component hydrates exact durable rows without sending; readiness drains ordered distinct bytes once',async()=>{
 const f=fixture(true)
 let mounted,controller
 try{
 f.chat.importDraft({text:'saved',attachments:f.paths.map(path=>({path}))});f.chat.querySelector('.chat-send').click()
 await until(()=>f.read().entries.length===1&&f.chat.exportDraft().attachments.length===0)
 f.chat.dispose();f.conversation.dispose()
 controller=createImageConversation({bridge:f.bridge,sessionId:'session',isCurrent:()=>true,mayDrain:()=>true,subscribeReady:()=>()=>{}})
 mounted=buildChat({seed:0,chips:{},imageOutbox:controller})
 dom.document.body.appendChild(mounted)
 await controller.refresh()
 assert.equal(mounted.querySelectorAll('.chat-image-queue-row').length,1)
 assert.equal(mounted.querySelector('.chat-image-queue-row').textContent.includes('2 image(s)'),true)
 assert.equal(f.sent.length,0)
 await controller.signalReady()
 assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].bytes,f.pngs.map(digest))
 await controller.signalReady();assert.equal(f.sent.length,1)
 assert.equal(mounted.querySelectorAll('.chat-image-queue-row').length,0)
 }finally{mounted?.dispose();controller?.dispose();f.chat.dispose();f.conversation.dispose()}
})
test('Unqueue uses displayed generation; stale click cannot cancel refreshed row, current click preserves composer',async()=>{
 const f=fixture(true)
 try{
 f.chat.importDraft({text:'queued',attachments:f.paths.map(path=>({path}))});f.chat.querySelector('.chat-send').click()
 await until(()=>f.chat.querySelector('.chat-image-queue-cancel'))
 const oldButton=f.chat.querySelector('.chat-image-queue-cancel')
 const current=f.read()
 f.service.run({operation:'write',conversationId:'conversation',operationId:randomUUID(),expectedGeneration:current.generation,entries:current.entries},f.ownerContext)
 await f.conversation.refresh()
 const before=f.calls.filter(r=>r.operation==='cancel').length
 oldButton.click()
 await until(()=>f.chat.textContent.includes('IMAGE_QUEUE_CANCEL_UNAVAILABLE'))
 assert.equal(f.calls.filter(r=>r.operation==='cancel').length,before)
 f.chat.importDraft({text:'unrelated draft',attachments:[{path:f.paths[1]}]})
 f.chat.querySelector('.chat-image-queue-cancel').click()
 await until(()=>f.read().entries[0].state==='cancelled')
 assert.equal(f.chat.exportDraft().text,'unrelated draft');assert.deepEqual(f.chat.exportDraft().attachments,[{path:f.paths[1]}])
 assert.equal(f.sent.length,0)
 }finally{f.chat.dispose();f.conversation.dispose()}
})
test('unknown reload stays visibly held and cannot Unqueue or dispatch',async()=>{
 const f=fixture(false,{conflictAfterSend:true});let controller,mounted
 try{
 f.chat.importDraft({text:'uncertain retention',attachments:f.paths.map(path=>({path}))});f.chat.querySelector('.chat-send').click()
 await until(()=>f.read().entries[0]?.state==='unknown'&&f.sent.length===1)
 f.chat.dispose();f.conversation.dispose()
 controller=createImageConversation({bridge:f.bridge,sessionId:'session',isCurrent:()=>true,mayDrain:()=>true,subscribeReady:()=>()=>{}})
 mounted=buildChat({seed:0,chips:{},imageOutbox:controller});dom.document.body.appendChild(mounted)
 await controller.refresh();assert.equal(mounted.querySelector('.chat-image-queue-row').dataset.deliveryState,'unknown')
 assert.equal(mounted.querySelector('.chat-image-queue-cancel'),null)
 await controller.signalReady();assert.equal(f.sent.length,1)
 }finally{mounted?.dispose();controller?.dispose();f.chat.dispose();f.conversation.dispose()}
})


for (const mutation of ['composition', 'attachment-restore', 'refresh-only']) test('pending image admission composer revision: '+mutation,async()=>{
 let release,entered
 const gate=new Promise(r=>release=r),atAdmit=new Promise(r=>entered=r)
 const f=fixture(true,{beforeAdmit:async()=>{entered();await gate}})
 try{
  const original={text:'original\\ntext  ',attachments:f.paths.map(path=>({path}))}
  f.chat.importDraft(original)
  f.chat.querySelector('.chat-send').click()
  await atAdmit
  assert.equal(f.chat.exportDraft().text,original.text)
  assert.deepEqual(f.chat.exportDraft().attachments,original.attachments)
  if(mutation==='composition'){
   const input=f.chat.querySelector('.chat-input input')
   assert.ok(input,'mounted production composer input exists')
   input.value='composing'
   input.dispatchEvent(new Event('input',{bubbles:true}))
   input.value=original.text
   input.dispatchEvent(new Event('compositionend',{bubbles:true}))
  }else if(mutation==='attachment-restore'){
   f.chat.importDraft({...original,attachments:original.attachments.slice().reverse()})
   f.chat.importDraft(original)
  }else{
   await f.conversation.refresh()
  }
  release()
  await until(()=>Boolean(f.chat.querySelector('.chat-image-intent-summary')))
  if(mutation==='refresh-only'){
   assert.equal(f.chat.exportDraft().text,'')
   assert.deepEqual(f.chat.exportDraft().attachments,[])
  }else{
   assert.equal(f.chat.exportDraft().text,original.text)
   assert.deepEqual(f.chat.exportDraft().attachments,original.attachments)
  }
  assert.equal(f.calls.filter(r=>r.operation==='admit').length,1)
  assert.equal(f.sent.length,0)
 }finally{release();f.chat.dispose();f.conversation.dispose()}
})

test.after(()=>dom.restore())
