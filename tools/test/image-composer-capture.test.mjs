import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
const dom=installDomStandIn()
const {buildChat}=await import('../../src/components.js')
const draft={text:'original\n  ',attachments:[{path:'one.png'},{path:'two.png'}]}
const create=options=>{const chat=buildChat({seed:0,chips:{},onSend:()=>assert.fail('captured images must use the image intent sender'),...options});dom.document.body.appendChild(chat);return chat}
const token=capture=>({version:1,draftId:capture.draftId,revision:capture.revision,text:capture.text,
 images:capture.attachments.map(({path})=>({path})),ownerContext:{version:1,ownerId:'fixture',currentEpoch:'epoch',kind:'local'},
 conversationId:'conversation',imageReceipts:[{version:1,id:'receipt',slot:0,manifestHash:'a'.repeat(64),imageCount:2}]})
test('explicit unchanged remount carries captured identity and receipts only on actual Send',async()=>{
 const source=create(),targetCalls=[]
 let entered;const invoked=new Promise(r=>entered=r)
 const target=create({onImageIntent:async value=>{targetCalls.push(value);entered();return{ok:false,code:'FIXTURE_HELD',isCurrent:()=>true}}})
 try{
  source.importDraft(draft)
  const captured=source.captureDraft(),kept=token(captured)
  assert.equal(Object.isFrozen(captured),true)
  assert.equal(source.attachRetainedDraft(captured,kept),true)
  source.dispose()
  assert.equal(target.restoreCapturedDraft(captured,kept),true)
  assert.equal(targetCalls.length,0)
  assert.deepEqual(target.exportDraft().attachments,draft.attachments)
  target.querySelector('.chat-send').click();await invoked
  assert.equal(targetCalls[0].draftId,captured.draftId)
  assert.equal(targetCalls[0].revision,captured.revision)
  assert.deepEqual(targetCalls[0].retainedDraft,kept)
  assert.equal(targetCalls[0].text,draft.text)
 }finally{source.dispose();target.dispose()}
})
test('ordinary import cannot restore a capture identity or overwrite a destination draft',()=>{
 const source=create(),target=create()
 try{
  source.importDraft(draft);const captured=source.captureDraft()
  target.importDraft(captured)
  assert.notEqual(target.captureDraft().draftId,captured.draftId)
  assert.equal(target.restoreCapturedDraft(captured,token(captured)),false)
  assert.equal(target.exportDraft().text,draft.text)
 }finally{source.dispose();target.dispose()}
})
test('edit-away/back and owner invalidation fence captured restore without clearing original images',()=>{
 const source=create(),target=create()
 try{
  source.importDraft(draft);const captured=source.captureDraft()
  const input=source.querySelector('.chat-input input')
  input.value='changed';input.dispatchEvent(new Event('input',{bubbles:true}))
  input.value=draft.text;input.dispatchEvent(new Event('input',{bubbles:true}))
  assert.equal(source.attachRetainedDraft(captured,token(captured)),false)
  assert.equal(target.restoreCapturedDraft(captured,token(captured)),false)
  const fresh=source.captureDraft()
  source.invalidateDraftAuthority('IMAGE_OWNER_CHANGED')
  assert.equal(target.restoreCapturedDraft(fresh,token(fresh)),false)
  assert.deepEqual(source.exportDraft().attachments,draft.attachments)
  assert.equal(source.exportDraft().text,draft.text)
 }finally{source.dispose();target.dispose()}
})
test.after(()=>dom.restore())
