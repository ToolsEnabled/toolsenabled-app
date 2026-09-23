import test from 'node:test'
import {Worker} from 'node:worker_threads'
import assert from 'node:assert/strict'
import Module, {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,realpathSync,renameSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'

const require=createRequire(import.meta.url)
const appRoot=resolve(process.env.IMAGE_APP_ROOT)
const tempRoot=realpathSync(process.env.IMAGE_TEST_TEMP)
const {createDurableImageCustody}=require(join(appRoot,'shell/durable-image-custody.cjs'))
const outboxPath=join(appRoot,'shell/image-outbox.cjs')
let outboxModule=require(outboxPath)
if(process.env.IMAGE_REVIEW_MUTATION==='automatic-replay') {
  const source=readFileSync(outboxPath,'utf8')
  const changed=source.replace('automaticSend: false','automaticSend: true')
  assert.notEqual(changed,source,'review mutation must apply')
  const loaded=new Module(outboxPath)
  loaded.filename=outboxPath
  loaded.paths=Module._nodeModulePaths(appRoot)
  loaded._compile(changed,outboxPath)
  outboxModule=loaded.exports
}
const {createImageOutbox}=outboxModule
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const sources=['durable-image-custody.cjs','image-outbox.cjs'].map(name=>join(appRoot,'shell',name))
const measured=()=>Object.fromEntries(sources.map(file=>[file,hash(readFileSync(file))]))
const before=measured()
console.log('REVIEW_SOURCE_BEFORE '+JSON.stringify(before))
test.after(()=>{const after=measured();console.log('REVIEW_SOURCE_AFTER '+JSON.stringify(after));assert.deepEqual(after,before)})

function image(color) {
  function crc(bytes) {
    let value=0xffffffff
    for(const byte of bytes) {value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0)}
    return (value^0xffffffff)>>>0
  }
  function chunk(type,bytes) {
    const result=Buffer.alloc(bytes.length+12)
    result.writeUInt32BE(bytes.length)
    result.write(type,4)
    bytes.copy(result,8)
    result.writeUInt32BE(crc(result.subarray(4,-4)),result.length-4)
    return result
  }
  const header=Buffer.alloc(13)
  header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0,...color]))),chunk('IEND',Buffer.alloc(0))])
}

function harness() {
  const root=mkdtempSync(join(tempRoot,'image-custody-review-'))
  const custodyRoot=join(root,'custody'),outboxRoot=join(root,'outbox')
  mkdirSync(custodyRoot);mkdirSync(outboxRoot)
  const context={owner:'person-one'}
  const authenticate=context=>({authenticated:!!context?.owner,productOwnerId:context?.owner})
  const makeCustody=()=>createDurableImageCustody({
    root:custodyRoot,authenticate,engineImageBytes:3000000,
    authorizeCandidate:({candidate})=>candidate.accountId==='chosen-account'&&candidate.sessionId==='successor',
  })
  let custody=makeCustody()
  const scope={conversationId:'conversation',accountId:'original-account',provider:'codex'}
  const input=[image([255,0,0]),image([0,0,255])].map(bytes=>({mime:'image/png',bytes}))
  const retain=images=>custody.retain({...scope,operationId:randomUUID(),images},context)
  const makeOutbox=(extra={})=>createImageOutbox({root:outboxRoot,conversationId:scope.conversationId,authenticate,...extra,
    validateReceipt:(receipt,{context,conversationId})=>{
      const reopened=custody.reopen(receipt,context)
      return reopened.conversationId===conversationId?reopened.images.length:0
    },
  })
  return {root,custodyRoot,outboxRoot,context,input,retain,scope,makeCustody,makeOutbox}
}

function entry(receipt,state='not-sent') {
  return {envelopeId:randomUUID(),text:'  exact words  ',imageReceipts:[receipt],state}
}

test('reconstruction reads retained disk bytes in order; candidate account and owner must be authorized',()=>{
  const h=harness(),receipt=h.retain(h.input)
  h.input.forEach(image=>image.bytes.fill(0))
  const custody=h.makeCustody()
  const candidate={...h.scope,accountId:'chosen-account',provider:'claude',sessionId:'successor',productOwnerId:h.context.owner}
  const reopened=custody.reopen(receipt,h.context)
  assert.equal(reopened.automaticSend,false)
  const issued=custody.reissue(receipt,candidate,h.context)
  assert.deepEqual(issued.images.map(row=>hash(readFileSync(row.path))),receipt.images.map(row=>row.sha256))
  assert.equal(issued.automaticSend,false)
  assert.throws(()=>custody.reopen(receipt,{owner:'another-person'}),{code:'IMAGE_CUSTODY_OWNER'})
  assert.throws(()=>custody.reissue(receipt,{...candidate,accountId:'wrong-account'},h.context),{code:'IMAGE_CUSTODY_CANDIDATE_REFUSED'})
  assert.throws(()=>custody.reissue(receipt,{...candidate,provider:'local'},h.context),{code:'IMAGE_CUSTODY_PROVIDER_UNSUPPORTED'})
  writeFileSync(issued.images[0].path,image([0,255,0]))
  assert.throws(()=>custody.reissue(receipt,candidate,h.context),{code:'IMAGE_CUSTODY_CORRUPT'})
})

test('outbox reconstructs exact text, receipts and unknown disposition without automatic replay',()=>{
  const h=harness(),receipt=h.retain(h.input),outbox=h.makeOutbox()
  const saved=entry(receipt,'unknown')
  const first=outbox.write({operationId:randomUUID(),expectedGeneration:null,entries:[saved]},h.context)
  const next=h.makeOutbox().read(h.context)
  assert.equal(next.generation,first.generation)
  assert.equal(next.entries[0].text,saved.text)
  assert.equal(next.entries[0].state,'unknown')
  assert.equal(next.automaticSend,false)
  assert.throws(()=>h.makeOutbox().read({owner:'another-person'}),{code:'IMAGE_OUTBOX_OWNER'})
})

test('independent writers reject stale generation after identical-content revision',()=>{
  const h=harness(),a=h.makeOutbox(),b=h.makeOutbox(),item=entry(h.retain(h.input))
  const first=a.write({operationId:randomUUID(),expectedGeneration:null,entries:[item]},h.context)
  assert.throws(()=>b.write({operationId:randomUUID(),expectedGeneration:null,entries:[item]},h.context),{code:'IMAGE_OUTBOX_STALE'})
  const empty=b.write({operationId:randomUUID(),expectedGeneration:first.generation,entries:[item]},h.context)
  assert.notEqual(empty.generation,first.generation)
  assert.throws(()=>a.write({operationId:randomUUID(),expectedGeneration:first.generation,entries:[item]},h.context),{code:'IMAGE_OUTBOX_STALE'})
  assert.throws(()=>a.write({operationId:randomUUID(),expectedGeneration:null,entries:[item]},h.context),{code:'IMAGE_OUTBOX_STALE'})
})

for(const state of ['unknown','accepted'])test(state+' envelope cannot be rearmed or rebound',()=>{
  const h=harness(),outbox=h.makeOutbox(),saved=entry(h.retain(h.input),state)
  const first=outbox.write({operationId:randomUUID(),expectedGeneration:null,entries:[saved]},h.context)
  for(const replacement of [{...saved,state:'not-sent'},{...saved,text:'different'}])
    assert.throws(()=>outbox.write({operationId:randomUUID(),expectedGeneration:first.generation,entries:[replacement]},h.context),
      {code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
})

test('committed operation retry is idempotent; changing its payload refuses',()=>{
  const h=harness(),outbox=h.makeOutbox()
  const request={operationId:randomUUID(),expectedGeneration:null,entries:[entry(h.retain(h.input))]}
  const first=outbox.write(request,h.context)
  assert.deepEqual(h.makeOutbox().write(request,h.context),first)
  assert.throws(()=>outbox.write({...request,entries:[]},h.context),{code:'IMAGE_OUTBOX_IDEMPOTENCY_CONFLICT'})
})

test('sparse image input refuses before issuing a durable receipt',()=>{
  const h=harness()
  assert.throws(()=>h.retain(Array(1)),e=>typeof e.code==='string'&&e.code.startsWith('IMAGE_CUSTODY_'))
})

test('sparse outbox entries refuse before committing unreadable history',()=>{
  const h=harness()
  assert.throws(()=>h.makeOutbox().write({operationId:randomUUID(),expectedGeneration:null,entries:Array(1)},h.context),
    e=>typeof e.code==='string'&&e.code.startsWith('IMAGE_OUTBOX_'))
})

test('sparse receipt references refuse before committing unreadable history',()=>{
  const h=harness(),outbox=h.makeOutbox()
  const bad={envelopeId:randomUUID(),text:'look',imageReceipts:Array(1),state:'not-sent'}
  assert.throws(()=>outbox.write({operationId:randomUUID(),expectedGeneration:null,entries:[bad]},h.context),
    e=>typeof e.code==='string'&&e.code.startsWith('IMAGE_OUTBOX_'))
})

test('concurrent writers admit exactly one commit from the same generation',async()=>{
  const h=harness(),saved=entry(h.retain(h.input))
  const gate=new SharedArrayBuffer(4),flag=new Int32Array(gate)
  const workers=[]
  const body=`
    const {parentPort,workerData:d}=require('node:worker_threads')
    const {join}=require('node:path')
    const {createDurableImageCustody}=require(join(d.appRoot,'shell/durable-image-custody.cjs'))
    const {createImageOutbox}=require(join(d.appRoot,'shell/image-outbox.cjs'))
    const authenticate=()=>({authenticated:true,productOwnerId:d.context.owner})
    const custody=createDurableImageCustody({root:d.custodyRoot,authenticate,authorizeCandidate:()=>false})
    const outbox=createImageOutbox({root:d.outboxRoot,conversationId:'conversation',authenticate,
      validateReceipt:receipt=>custody.reopen(receipt,d.context).images.length})
    parentPort.postMessage({ready:true})
    Atomics.wait(new Int32Array(d.gate),0,0)
    try {parentPort.postMessage({result:outbox.write(d.request,d.context)})}
    catch(e) {parentPort.postMessage({code:e.code,message:e.message})}
  `
  try {
    const outcomes=[]
    let ready=0
    for(let i=0;i<2;i++) {
      const worker=new Worker(body,{eval:true,workerData:{appRoot,custodyRoot:h.custodyRoot,outboxRoot:h.outboxRoot,
        context:h.context,gate,request:{operationId:randomUUID(),expectedGeneration:null,entries:[saved]}}})
      workers.push(worker)
      outcomes.push(new Promise((resolve,reject)=>{
        worker.on('error',reject)
        worker.on('message',message=>{
          if(message.ready) {if(++ready===2){Atomics.store(flag,0,1);Atomics.notify(flag,0)}}
          else resolve(message)
        })
      }))
    }
    const answers=await Promise.all(outcomes)
    assert.equal(answers.filter(a=>a.result).length,1)
    const refused=answers.find(a=>!a.result)
    assert.ok(['IMAGE_OUTBOX_STALE','IMAGE_OUTBOX_INCOMPLETE'].includes(refused.code),JSON.stringify(refused))
    assert.equal(h.makeOutbox().read(h.context).entries.length,1)
  } finally {await Promise.all(workers.map(worker=>worker.terminate()))}
})

for(const state of ['not-sent','unknown','accepted'])test('ordinary write cannot silently omit '+state+' envelope',()=>{
  const h=harness(),outbox=h.makeOutbox(),saved=entry(h.retain(h.input),state)
  const first=outbox.write({operationId:randomUUID(),expectedGeneration:null,entries:[saved]},h.context)
  assert.throws(()=>outbox.write({operationId:randomUUID(),expectedGeneration:first.generation,entries:[]},h.context),
    error=>typeof error.code==='string'&&error.code.startsWith('IMAGE_OUTBOX_'))
  assert.equal(outbox.read(h.context).entries[0].envelopeId,saved.envelopeId)
})

test('explicit cancel and retirement preserve anti-rearm history without deleting bytes',()=>{
  const h=harness(),box=h.makeOutbox(),receipt=h.retain(h.input)
  const pending=entry(receipt),unknown=entry(receipt,'unknown'),accepted=entry(receipt,'accepted')
  const first=box.write({operationId:randomUUID(),expectedGeneration:null,entries:[pending,unknown,accepted]},h.context)
  for(const operation of ['cancel','retireAccepted']) {
    assert.throws(()=>box[operation]({operationId:randomUUID(),expectedGeneration:first.generation,envelopeIds:[unknown.envelopeId]},h.context),
      {code:'IMAGE_OUTBOX_RETIRE_REFUSED'})
  }
  const cancelled=box.cancel({operationId:randomUUID(),expectedGeneration:first.generation,envelopeIds:[pending.envelopeId]},h.context)
  assert.equal(cancelled.entries.find(e=>e.envelopeId===pending.envelopeId).state,'cancelled')
  const retired=box.retireAccepted({operationId:randomUUID(),expectedGeneration:cancelled.generation,
    envelopeIds:[pending.envelopeId,accepted.envelopeId]},h.context)
  assert.deepEqual(retired.entries.map(e=>e.envelopeId),[unknown.envelopeId])
  const reconstructed=h.makeOutbox()
  for(const prior of [pending,accepted]) {
    assert.throws(()=>reconstructed.write({operationId:randomUUID(),expectedGeneration:retired.generation,
      entries:[unknown,{...prior,state:'not-sent'}]},h.context),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
  }
  assert.equal(h.makeCustody().reopen(receipt,h.context).images.length,2)
})

test('destination transfer is authorized, generation checked and retained across reconstruction',()=>{
  const h=harness(),item=entry(h.retain(h.input))
  const box=h.makeOutbox({destinationSessionId:'original',authorizeTransfer:request=>
    request.sourceSessionId==='original'&&request.destinationSessionId==='successor'})
  const first=box.write({operationId:randomUUID(),expectedGeneration:null,entries:[item]},h.context)
  assert.equal(first.destinationSessionId,'original')
  assert.throws(()=>box.transfer({operationId:randomUUID(),expectedGeneration:first.generation,
    expectedDestinationSessionId:'wrong',destinationSessionId:'successor'},h.context),{code:'IMAGE_OUTBOX_DESTINATION_STALE'})
  assert.throws(()=>box.transfer({operationId:randomUUID(),expectedGeneration:first.generation,
    expectedDestinationSessionId:'original',destinationSessionId:'unauthorized'},h.context),{code:'IMAGE_OUTBOX_TRANSFER_REFUSED'})
  const moved=box.transfer({operationId:randomUUID(),expectedGeneration:first.generation,
    expectedDestinationSessionId:'original',destinationSessionId:'successor'},h.context)
  assert.equal(moved.destinationSessionId,'successor')
  assert.equal(moved.automaticSend,false)
  const reconstructed=h.makeOutbox({destinationSessionId:'different-default'}).read(h.context)
  assert.equal(reconstructed.destinationSessionId,'successor')
  assert.deepEqual(reconstructed.entries,moved.entries)
  assert.throws(()=>box.transfer({operationId:randomUUID(),expectedGeneration:first.generation,
    expectedDestinationSessionId:'original',destinationSessionId:'successor'},h.context),{code:'IMAGE_OUTBOX_STALE'})
})

test('reused numeric reservation cannot make an old issued path name replacement bytes',()=>{
 const h=harness(),custody=h.makeCustody(),oldReceipt=h.retain(h.input)
 const candidate={...h.scope,accountId:'chosen-account',sessionId:'successor',productOwnerId:h.context.owner}
 const oldPath=custody.reissue(oldReceipt,candidate,h.context).images[0].path
 const oldDirectory=dirname(oldPath)
 renameSync(oldDirectory,join(h.root,'preserved-original-reservation'))
 const replacement=[{mime:'image/png',bytes:image([0,255,0])}]
 const newReceipt=h.retain(replacement)
 const newPath=custody.reissue(newReceipt,candidate,h.context).images[0].path
 assert.equal(dirname(newPath),oldDirectory,'fixture must reuse the same numeric slot')
 assert.notEqual(newPath,oldPath)
 assert.throws(()=>readFileSync(oldPath),{code:'ENOENT'})
 assert.deepEqual(readFileSync(newPath),replacement[0].bytes)
 assert.throws(()=>custody.reissue(oldReceipt,candidate,h.context),{code:'IMAGE_CUSTODY_CORRUPT'})
})
