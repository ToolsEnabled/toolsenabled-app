import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {deflateSync} from 'node:zlib'
const require=createRequire(import.meta.url)
const appRoot=resolve(process.env.IMAGE_APP_ROOT)
const tempRoot=realpathSync(process.env.IMAGE_TEST_TEMP)
const source=join(appRoot,'shell/image-retention-service.cjs')
const {createImageRetentionService}=require(source)
const hash=b=>createHash('sha256').update(b).digest('hex')
const before=hash(readFileSync(source))
console.log('SERVICE_BEFORE '+before)
test.after(()=>{const after=hash(readFileSync(source));console.log('SERVICE_AFTER '+after);assert.equal(after,before)})
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

function fixture(selection=null) {
  const root=mkdtempSync(join(tempRoot,'image-service-review-'))
  const bytes=[image([255,0,0]),image([0,0,255])]
  const paths=bytes.map((data,index)=>{const file=join(root,index+'.png');writeFileSync(file,data);return file})
  const context={productOwnerId:'owner-fixture'}
  const session={}
  const issued=new Set()
  let reads=0,changeAccount=false,changeSession=false,changeSessionId=false,candidateEffort=null
  const service=createImageRetentionService({
    root:join(root,'retained'),
    authenticate:ctx=>{if(ctx!==context)throw Object.assign(new Error('wrong owner'),{code:'IMAGE_CUSTODY_AUTH_REQUIRED'});return {authenticated:true,...context}},
    sourceAuthority:()=>({accountId:'original-account',provider:'codex',issued:new Set(paths)}),
    candidateAuthority:()=>{
      reads++
      const claimed=changeSessionId&&service.run({operation:'read',conversationId:'conversation'},context).result.entries[0]?.state==='unknown'
      return {session:changeSession&&reads>=3?{}:session,sessionId:claimed?'different-session':'successor',effort:candidateEffort,model:'fixture-model',
        accountId:changeAccount&&reads>=3?'unexpected-account':'chosen-account',provider:'claude',issued}
    },
    authorizeTransfer:request=>request.destinationSessionId==='successor',
    engineImageBytes:3000000,
  })
  const run=request=>service.run({conversationId:'conversation',...request},context)
  const receipt=run({operation:'retain',operationId:randomUUID(),images:paths.map(path=>({path}))}).result
  const admitted=run({operation:'admit',operationId:randomUUID(),expectedGeneration:null,text:'',
    imageReceipts:[receipt],...(selection?{selection}:{})}).result
  const moved=run({operation:'transfer',operationId:randomUUID(),expectedGeneration:admitted.generation,
    expectedDestinationSessionId:null,destinationSessionId:'successor'}).result
  const envelopeId=moved.entries[0].envelopeId
  return {service,run,context,paths,bytes,issued,receipt,moved,envelopeId,
    changeSessionId:()=>{changeSessionId=true},changeEffort:effort=>{candidateEffort=effort},changeAccount:()=>{changeAccount=true},changeSession:()=>{changeSession=true}}
}

test('service reissues retained byte paths into the actual candidate issued Set',()=>{
  const h=fixture()
  const receipt=h.run({operation:'reissue',envelopeId:h.envelopeId}).result
  assert.equal(receipt.automaticSend,false)
  assert.equal(receipt.sessionId,'successor')
  assert.equal(receipt.images.length,2)
  assert.deepEqual(receipt.images.map(i=>readFileSync(i.path)),h.bytes)
  assert.deepEqual([...h.issued],receipt.images.map(i=>i.path))
  assert.ok(receipt.images.every(i=>!h.paths.includes(i.path)))
})

test('unknown or accepted envelope cannot reissue bytes to a session',()=>{
  for(const state of ['unknown','accepted']) {
    const h=fixture()
    h.run({operation:'write',operationId:randomUUID(),expectedGeneration:h.moved.generation,
      entries:h.moved.entries.map(entry=>({...entry,state}))})
    assert.throws(()=>h.run({operation:'reissue',envelopeId:h.envelopeId}),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
    assert.equal(h.issued.size,0)
  }
})

test('candidate instance changing during reissue refuses before granting paths',()=>{
  const h=fixture();h.changeSession()
  assert.throws(()=>h.run({operation:'reissue',envelopeId:h.envelopeId}),{code:'IMAGE_CUSTODY_CANDIDATE_REFUSED'})
  assert.equal(h.issued.size,0)
})

test('candidate account changing during reissue refuses before granting paths',()=>{
  const h=fixture();h.changeAccount()
  assert.throws(()=>h.run({operation:'reissue',envelopeId:h.envelopeId}),{code:'IMAGE_CUSTODY_CANDIDATE_REFUSED'})
  assert.equal(h.issued.size,0)
})
for(const kind of ['sessionId','null-effort'])test('dispatch refuses changed '+kind+' before send',async()=>{
 const h=fixture(kind==='null-effort'?{model:'fixture-model',effort:null}:null)
 if(kind==='sessionId')h.changeSessionId()
 else h.changeEffort('high')
 const calls=[]
 let outcome
 try {
  outcome=await h.service.dispatch({conversationId:'conversation',envelopeId:h.envelopeId,
   expectedGeneration:h.moved.generation,operationId:randomUUID()},h.context,async request=>{
    calls.push(request);return {deliveryDisposition:'accepted',result:{fixture:true}}
   })
 } catch(error) {outcome={code:error.code}}
 assert.equal(calls.length,0,'changed destination identity or effective effort must refuse before send')
 assert.ok(['IMAGE_CUSTODY_CANDIDATE_REFUSED','IMAGE_QUEUE_SELECTION_CHANGED'].includes(outcome.code))
})