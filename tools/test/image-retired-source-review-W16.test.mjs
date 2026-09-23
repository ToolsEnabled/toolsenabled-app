import test from 'node:test'
import assert from 'node:assert/strict'
import Module, {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import {parseAst} from 'rollup/parseAst'

const appRoot=path.resolve(process.env.IMAGE_APP_ROOT)
const mainPath=path.join(appRoot,'shell/main.cjs')
const require=createRequire(mainPath)
const source=readFileSync(mainPath,'utf8')
const ast=parseAst(source)
const statement=ast.body.find(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'
 &&n.expression.callee.object?.name==='ipcMain'&&n.expression.callee.property?.name==='handle'
 &&n.expression.arguments[0]?.value==='mc-agent:image-queue')
assert.ok(statement,'actual IPC registration must exist')
const callback=statement.expression.arguments[1]
const body=source.slice(callback.start,callback.end)
const runNode=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='runImageQueue')
assert.ok(runNode,'actual queue implementation must exist')
const queueBody=source.slice(runNode.start,runNode.end)
const functions=['agentIpcError','agentPayload','boundedAgentString','parseAgentSend','assertTrustedAgentSender','windowPrincipal'].map(name=>{
 const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name)
 assert.ok(n,name);return source.slice(n.start,n.end)
}).join('\n')
const limitCode=ast.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations).filter(n=>['MAX_SESSION_ID_LENGTH','MAX_TURN_TEXT_LENGTH'].includes(n.id.name)).map(n=>'const '+source.slice(n.start,n.end)+';').join('\n')
const helpers=new Function('trustedFleetProfileSender',limitCode+'\n'+functions+';return {agentIpcError,agentPayload,parseAgentSend,assertTrustedAgentSender,windowPrincipal}')(event=>event.trusted===true)
const {createAgentCommandSurface,REQUIRED_DEPS}=require('./agent-command-surface.cjs')
const sha=value=>createHash('sha256').update(value).digest('hex')
const tracked=['agent-host.cjs','main.cjs','agent-command-surface.cjs','image-retention-service.cjs','durable-image-custody.cjs','image-outbox.cjs']
const measured=()=>Object.fromEntries(tracked.map(f=>[f,sha(readFileSync(path.join(appRoot,'shell',f)))]))
const before=measured()
console.log('IPC_BEFORE '+JSON.stringify(before))
test.after(()=>{const after=measured();console.log('IPC_AFTER '+JSON.stringify(after));assert.deepEqual(after,before)})
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

function fixture(provider='codex',fullHost=null) {
 let beforeTracked=null
 const root=mkdtempSync(path.join(realpathSync(process.env.IMAGE_TEST_TEMP),'image-ipc-review-'))
 const owner={isDestroyed:()=>false},ownerContext={epoch:'fixture'}
 const pixels=[image([255,0,0]),image([0,0,255])]
 const images=pixels.map((bytes,i)=>{const file=path.join(root,i+'.png');writeFileSync(file,bytes);return {path:file}})
 const sessions=new Map([
 ['source',{owner,state:'ready',metricsPrincipal:'product-owner',attachments:new Set(images.map(i=>i.path))}],
 ['successor',{owner,state:'ready',metricsPrincipal:'product-owner',attachments:new Set()}],
 ])
 const metadata=new Map([['source',{account:'source-account',provider:'codex'}],['successor',{account:'chosen-account',provider}]])
 const bindings=new Map([['source',{nodeId:'conversation'}],['successor',{nodeId:'conversation'}]])
 const deps={}
 for(const [name,kind]of Object.entries(REQUIRED_DEPS))deps[name]=kind==='function'?()=>null:kind==='number'?128:kind==='string'?root:{}
 Object.assign(deps,{agentSessions:sessions,agentIpcError:helpers.agentIpcError,parseAgentSend:helpers.parseAgentSend,
 currentAgentHost:()=>({sendTurnTracked:async request=>{if(beforeTracked)await beforeTracked();return fullHost.sendTurnTracked(request)}}),dialog:{showOpenDialog:()=>{}},AGENT_EFFORT_VALUES:[]})
 Object.assign(deps,{parseAgentPasteAttachment:value=>value,MAX_PASTE_IMAGE_BYTES:8*1024*1024,rendererSafeAgentError:error=>error,savePasteAttachment:async()=>({path:images[0].path,size:pixels[0].length})})
 const surface=createAgentCommandSurface(deps)
 const event={trusted:true,sender:owner}
 const environment={...helpers,getAgentCommandSurface:()=>surface,getImageOwnerContext:()=>({
 authenticate:context=>{if(context!==ownerContext)helpers.agentIpcError('IMAGE_OWNER_CHANGED','fixture owner changed');return {authenticated:true,productOwnerId:'product-owner'}},
 read:()=>ownerContext,
 }),accountPrincipal:()=> 'product-owner',agentSessions:sessions,agentHost:{holdQueuedUserMessage:(id,waiting)=>fullHost?.holdQueuedUserMessage(id,waiting),sessionTranscriptMetadata:id=>metadata.get(id),sessionDeliverySettings:id=>fullHost?fullHost.sessionDeliverySettings(id):({model:'fixture-model',effort:null,provider:metadata.get(id)?.provider})},
 transcriptCapture:{bindingFor:id=>bindings.get(id)},require,path,app:{getPath:()=>root},
 resolveCapabilityRoot:()=>path.resolve(process.env.IMAGE_ENGINE_ROOT)}
 deps.imageQueue=new Function(...Object.keys(environment),'return ('+queueBody+')')(...Object.values(environment))
 const handler=new Function(...Object.keys(environment),'return ('+body+')')(...Object.values(environment))
 const run=async request=>await handler(event,{conversationId:'conversation',ownerContext,...request})
 const retain=async()=>(await run({operation:'retain',operationId:randomUUID(),sessionId:'source',images})).result
 async function prepare() {
  const receipt=await retain()
  const admitted=(await run({operation:'admit',sessionId:'successor',operationId:randomUUID(),expectedGeneration:null,text:'',imageReceipts:[receipt]})).result
  const moved=(await run({operation:'transfer',operationId:randomUUID(),expectedGeneration:admitted.generation,
    expectedDestinationSessionId:null,destinationSessionId:'successor'})).result
  return {envelopeId:moved.entries[0].envelopeId,generation:moved.generation}
 }
 return {run,prepare,retain,event,handler,ownerContext,sessions,bindings,metadata,pixels,images,holdRetiredPaste:()=>surface.run('agent:paste-attachment',{sessionId:'source',holdKey:'conversation',mime:'image/png',data:pixels[0].toString('base64')},helpers.windowPrincipal(event)),setBeforeTracked:fn=>{beforeTracked=fn}}
}


test('original live source retain survives retirement and successor reissue',async()=>{
 const h=fixture(),receipt=await h.retain()
 h.sessions.get('source').ended=true
 h.sessions.get('source').state='ended'
 const admitted=(await h.run({operation:'admit',sessionId:'successor',operationId:randomUUID(),
  expectedGeneration:null,text:'',imageReceipts:[receipt]})).result
 const moved=(await h.run({operation:'transfer',operationId:randomUUID(),expectedGeneration:admitted.generation,
  expectedDestinationSessionId:null,destinationSessionId:'successor'})).result
 const issued=(await h.run({operation:'reissue',sessionId:'successor',envelopeId:moved.entries[0].envelopeId})).result
 assert.deepEqual(issued.images.map(image=>readFileSync(image.path)),h.pixels)
 assert.deepEqual([...h.sessions.get('successor').attachments],issued.images.map(image=>image.path))
 assert.equal(issued.automaticSend,false)
})
for(const held of [false,true])test('retired unadmitted '+(held?'window-held':'source-issued')+' paths require repick without successor grant',async()=>{
 const h=fixture()
 h.sessions.get('source').ended=true
 h.sessions.get('source').state='ended'
 if(held)await h.holdRetiredPaste()
 const composer={text:'  pending exact text  ',images:h.images.map(image=>({...image}))}
 const original=structuredClone(composer)
 const before=(await h.run({operation:'read'})).result
 const result=await h.run({operation:'retain',operationId:randomUUID(),sessionId:'source',images:composer.images})
 assert.equal(result.ok,false)
 assert.equal(result.code,'IMAGE_CUSTODY_REPICK_REQUIRED')
 assert.deepEqual(composer,original,'backend must not modify caller attachment descriptors')
 assert.equal(h.sessions.get('successor').attachments.size,0)
 assert.deepEqual((await h.run({operation:'read'})).result,before)
})
test('wrong owner wins over retired held path and leaves input and queue unchanged',async()=>{
 const h=fixture()
 h.sessions.get('source').ended=true
 await h.holdRetiredPaste()
 const images=h.images.map(image=>({...image})),original=structuredClone(images)
 const before=(await h.run({operation:'read'})).result
 const result=await h.run({operation:'retain',operationId:randomUUID(),sessionId:'source',images,
  ownerContext:{epoch:'previous-owner'}})
 assert.equal(result.ok,false);assert.equal(result.code,'IMAGE_OWNER_CHANGED')
 assert.deepEqual(images,original)
 assert.equal(h.sessions.get('successor').attachments.size,0)
 assert.deepEqual((await h.run({operation:'read'})).result,before)
})

test('old window-held path forwarded under successor cannot gain current-session custody',async()=>{
 const h=fixture()
 h.sessions.get('source').ended=true
 const held=await h.holdRetiredPaste()
 assert.equal(held.ok,true);assert.equal(held.held,true)
 const images=[{path:held.path}],original=structuredClone(images)
 const before=(await h.run({operation:'read'})).result
 const result=await h.run({operation:'retain',operationId:randomUUID(),sessionId:'successor',images})
 assert.equal(result.ok,false)
 assert.equal(result.code,'IMAGE_CUSTODY_REPICK_REQUIRED')
 assert.deepEqual(images,original)
 assert.equal(h.sessions.get('successor').attachments.size,0)
 assert.deepEqual((await h.run({operation:'read'})).result,before)
})
