'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createDurableImageCustody, custodyFileIO } = require('./durable-image-custody.cjs')
const { createImageOutbox } = require('./image-outbox.cjs')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = value => createHash('sha256').update(value).digest('hex')
function directory(target) {
  const parent = path.dirname(target)
  if (parent !== target) {
    try { custodyFileIO.plain(parent, true) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      directory(parent)
    }
  }
  try { fs.mkdirSync(target, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  custodyFileIO.plain(target, true)
}
function imageMime(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg'
  if (['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'image/gif'
  if (bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return 'image/webp'
  fail('IMAGE_CUSTODY_FORMAT')
}
// All entry points are synchronous: no IPC reply is admission until its receipt
// is returned. The caller supplies native owner/session/capability authority.
function createImageRetentionService({ root, authenticate, sourceAuthority, candidateAuthority, authorizeTransfer, engineImageBytes }) {
  if (!path.isAbsolute(root || '') || [authenticate,sourceAuthority,candidateAuthority,authorizeTransfer].some(f=>typeof f!=='function')) fail('IMAGE_RETENTION_CONFIGURATION')
  const dispatchPermit = Symbol('private image dispatch')
  const noDispatchProofs = new Set()
  function run(request, context, permit) {
    const auth = authenticate(context)
    if (!request || typeof request.conversationId !== 'string' || !request.conversationId || request.conversationId.length > 256) fail('IMAGE_OUTBOX_REQUEST')
    const conversationId = request.conversationId
    const conversationRoot = path.join(root, hash(auth.productOwnerId), hash(conversationId))
    const custodyRoot = path.join(conversationRoot,'assets'), outboxRoot = path.join(conversationRoot,'outbox')
    directory(custodyRoot); directory(outboxRoot)
    const custody = createDurableImageCustody({ root:custodyRoot, authenticate, engineImageBytes,
      authorizeCandidate: ({candidate}) => {
        const current = candidateAuthority(request, context)
        return current.sessionId === candidate.sessionId && current.accountId === candidate.accountId && current.provider === candidate.provider
      } })
    let readmissionCandidate
    const outbox = createImageOutbox({ root:outboxRoot, conversationId, authenticate,
      destinationSessionId:null, retainHistory:true, authorizeCompaction: () => true,
      validateReceipt: ref => {
        const saved=custody.reopen(ref,context)
        if (saved.conversationId!==conversationId) fail('IMAGE_OUTBOX_ASSET_REFUSED')
        return saved.images.length
      },
      authorizeTransfer: transfer => authorizeTransfer({...transfer,request},context) === true,
      authorizeNoDispatch: proof => noDispatchProofs.has(proof.attemptId),
      authorizeReadmission: () => {
        if (!readmissionCandidate) return false
        const current = candidateAuthority(request, context)
        return current.session === readmissionCandidate.session && current.sessionId === readmissionCandidate.sessionId
          && current.accountId === readmissionCandidate.accountId && current.provider === readmissionCandidate.provider
          && current.model === readmissionCandidate.model && current.effort === readmissionCandidate.effort
      } })
    let result
    switch(request.operation) {
      case 'read': result=outbox.read(context); break
      case 'preview': {
        const saved=outbox.read(context)
        const entry=saved.entries.find(row=>row.envelopeId===request.envelopeId)
        if(!entry || !['not-sent','unknown'].includes(entry.state) || !entry.imageReceipts.length) fail('IMAGE_OUTBOX_ENVELOPE_CONFLICT')
        const view=custody.preview(entry.imageReceipts[0],context)
        if(view.conversationId!==conversationId) fail('IMAGE_CUSTODY_SCOPE')
        result={version:1,envelopeId:entry.envelopeId,thumbnail:view.thumbnail,
          imageCount:entry.imageReceipts.reduce((total,ref)=>total+ref.imageCount,0),automaticSend:false}
        break
      }
      case 'retain': {
        if (!Array.isArray(request.images) || !request.images.length || request.images.length>8) fail('IMAGE_CUSTODY_COUNT')
        const source=sourceAuthority(request,context)
        const images=Array.from(request.images,image=>{
          if (!image || typeof image.path!=='string' || !source.issued.has(image.path)) fail('MC_AGENT_ATTACHMENT_UNKNOWN')
          const bytes=custodyFileIO.readBounded(image.path,8*1024*1024)
          return {mime:imageMime(bytes),bytes}
        })
        authenticate(context)
        result=custody.retain({operationId:request.operationId,conversationId,accountId:source.accountId,provider:source.provider,images},context)
        break
      }
      case 'reopen': {
        result=custody.reopen(request.receipt,context)
        if(result.conversationId!==conversationId) fail('IMAGE_CUSTODY_SCOPE')
        break
      }
      case 'reissue': {
        const candidate=candidateAuthority(request,context)
        const snapshot=outbox.read(context)
        if(snapshot.destinationSessionId!==candidate.sessionId) fail('IMAGE_OUTBOX_DESTINATION_STALE')
        const entry=snapshot.entries.find(item=>item.envelopeId===request.envelopeId)
        if(!entry || entry.state!=='not-sent') fail('IMAGE_OUTBOX_ENVELOPE_CONFLICT')
        const issued=[]
        for(const receipt of entry.imageReceipts) issued.push(...custody.reissue(receipt,{...candidate,conversationId,productOwnerId:auth.productOwnerId},context).images)
        authenticate(context)
        const current=candidateAuthority(request,context)
        if(current.session!==candidate.session || current.sessionId!==candidate.sessionId
          || current.accountId!==candidate.accountId || current.provider!==candidate.provider) fail('IMAGE_CUSTODY_CANDIDATE_REFUSED')
        for(const image of issued) current.issued.add(image.path)
        result={version:1,sessionId:candidate.sessionId,envelopeId:entry.envelopeId,generation:snapshot.generation,images:issued,automaticSend:false}
        break
      }
      case 'resend-current': {
        // This explicit operation carries identity only. Content and settings
        // are read from the retained envelope and the native destination.
        const allowed = ['operation','ownerContext','conversationId','sessionId','envelopeId','expectedGeneration','operationId']
        if (Object.keys(request).some(key => !allowed.includes(key))) fail('IMAGE_OUTBOX_REQUEST')
        const candidate = candidateAuthority(request, context)
        if (!candidate?.session || candidate.sessionId !== request.sessionId
          || typeof candidate.accountId !== 'string' || !candidate.accountId
          || typeof candidate.provider !== 'string' || !candidate.provider || candidate.provider === 'unresolved') fail('IMAGE_CUSTODY_CANDIDATE_REFUSED')
        if (typeof candidate.model !== 'string' || !candidate.model || candidate.model.length > 256
          || !(candidate.effort === null || (typeof candidate.effort === 'string'
            && candidate.effort.length > 0 && candidate.effort.length <= 256))) fail('IMAGE_QUEUE_SELECTION_REQUIRED')
        readmissionCandidate = { session: candidate.session, sessionId: candidate.sessionId,
          accountId: candidate.accountId, provider: candidate.provider, model: candidate.model, effort: candidate.effort }
        result = outbox.mutateWithCapacity({ ...request, sessionId: candidate.sessionId,
          selection: { model: candidate.model, effort: candidate.effort } }, context, 'resend-current')
        break
      }
      case 'reserveDispatchCapacity':
        if(permit!==dispatchPermit) fail('IMAGE_QUEUE_DISPATCH_AUTHORITY')
        result=outbox.reserveCapacity(request,context,2); break
      case 'beginDelivery': case 'resolveNoDispatch':
        if(permit!==dispatchPermit) fail('IMAGE_QUEUE_DISPATCH_AUTHORITY')
        result=outbox[request.operation](request,context); break
      case 'admit': case 'write': case 'cancel': case 'retireAccepted': case 'transfer':
        if(typeof outbox[request.operation]!=='function') fail('IMAGE_OUTBOX_OPERATION_UNAVAILABLE')
        result=outbox.mutateWithCapacity(request,context,request.operation); break
      default: fail('IMAGE_OUTBOX_OPERATION_UNAVAILABLE')
    }
    try { authenticate(context) } catch {
      return {ok:false,code:'IMAGE_OWNER_CHANGED',operationId:request.operationId||null,
        committed:['retain','admit','write','cancel','retireAccepted','transfer','resend-current'].includes(request.operation),
        generation:result?.generation??null,reconcile:true}
    }
    return {ok:true,operation:request.operation,operationId:request.operationId||null,result}
  }
  async function dispatch(request, context, send) {
    if(typeof send!=='function') fail('IMAGE_QUEUE_DISPATCH_AUTHORITY')
    const read=run({...request,operation:'read'},context)
    if(!read.ok) return read
    const snapshot=read.result
    if(snapshot.generation!==request.expectedGeneration) fail('IMAGE_OUTBOX_STALE')
    const entry=snapshot.entries.find(item=>item.envelopeId===request.envelopeId)
    if(!entry || entry.state!=='not-sent') fail('IMAGE_OUTBOX_ENVELOPE_CONFLICT')
    let candidate,issued,claimed
    try {
      candidate=candidateAuthority(request,context)
      if(entry.selection && entry.selection.effort!==(candidate.effort ?? null)) fail('IMAGE_QUEUE_SELECTION_CHANGED')
      if(entry.selection?.model && candidate.provider!=='codex' && entry.selection.model!==candidate.model) fail('IMAGE_QUEUE_SELECTION_CHANGED')
      // Busy is a native readiness fact. Keep the already-admitted envelope
      // intact; do not spend two durable revisions on a known pre-dispatch wait.
      if(candidate.busy===true) return {ok:false,code:'AGENT_TURN_ACTIVE',deliveryDisposition:'not-sent',
        dispatchStarted:false,retryable:true,retryAfterMs:1000,envelopeId:entry.envelopeId,result:snapshot,automaticSend:false}
      const capacity=run({...request,operation:'reserveDispatchCapacity'},context,dispatchPermit)
      if(!capacity.ok) return capacity
      if(capacity.result.compacted) request={...request,expectedGeneration:capacity.result.generation}
      issued=run({...request,operation:'reissue'},context)
      if(!issued.ok) return issued
      claimed=run({...request,operation:'beginDelivery'},context,dispatchPermit)
      if(!claimed.ok || claimed.result.delivery?.dispatchAllowed!==true) return {...claimed,automaticSend:false}
    } catch(error) {
      // Nothing reached send(). Remember a terminal pre-dispatch refusal so a
      // fresh renderer sees the same visible outcome instead of replaying it.
      const code=typeof error?.code==='string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : 'AGENT_SEND_FAILED'
      try {
        const latest=run({...request,operation:'read'},context).result
        const retained=latest.entries.find(item=>item.envelopeId===entry.envelopeId)
        if(!retained || retained.state!=='not-sent') throw error
        let result=latest
        if(retained.failure?.code!==code || retained.failure?.retryable!==false) {
          const saved=run({...request,operation:'write',operationId:require('node:crypto').randomUUID(),expectedGeneration:latest.generation,
            entries:latest.entries.map(item=>item===retained?{...item,failure:{code,retryable:false}}:item)},context)
          if(!saved.ok) throw error
          result=saved.result
        }
        return {ok:false,code,deliveryDisposition:'not-sent',dispatchStarted:false,retryable:false,
          envelopeId:entry.envelopeId,result,automaticSend:false}
      } catch {
        return {ok:false,code,deliveryDisposition:'not-sent',dispatchStarted:false,retryable:false,
          envelopeId:entry.envelopeId,reconcile:true,automaticSend:false}
      }
    }
    const claim=claimed.result, attemptId=claim.delivery.attemptId
    let delivery
    try {
      authenticate(context)
      const current=candidateAuthority(request,context)
      if(current.session!==candidate.session || current.sessionId!==candidate.sessionId
        || current.accountId!==candidate.accountId || current.provider!==candidate.provider) {
        delivery={ok:false,code:'IMAGE_CUSTODY_CANDIDATE_REFUSED',deliveryDisposition:'not-sent'}
      } else {
        delivery=await send({sessionId:candidate.sessionId,text:entry.text,images:issued.result.images.map(image=>({path:image.path})),
          ...(entry.selection?.model ? {model:entry.selection.model} : {})})
      }
    } catch(error) {
      // No assumption that an exception after calling a provider means refusal.
      delivery={ok:false,code:error?.code||'AGENT_SEND_FAILED',deliveryDisposition:'unknown'}
    }
    if(delivery.deliveryDisposition==='not-sent') {
      noDispatchProofs.add(attemptId)
      try {
        const resolution=run({...request,operation:'resolveNoDispatch',expectedGeneration:claim.generation,
          operationId:require('node:crypto').randomUUID(),attemptId,
          failure:{code:delivery.code||'AGENT_SEND_FAILED',retryable:delivery.code==='AGENT_TURN_ACTIVE'}},context,dispatchPermit)
        return {ok:false,code:delivery.code,deliveryDisposition:'not-sent',dispatchStarted:false,retryable:delivery.code==='AGENT_TURN_ACTIVE',
          ...(delivery.code==='AGENT_TURN_ACTIVE'?{retryAfterMs:1000}:{}),envelopeId:entry.envelopeId,attemptId,
          result:resolution.result,reconcile:resolution.ok!==true,automaticSend:false}
      } catch(error) {
        return {ok:false,code:error?.code||'IMAGE_OUTBOX_WRITE_FAILED',deliveryDisposition:'not-sent',dispatchStarted:false,
          envelopeId:entry.envelopeId,attemptId,reconcile:true,automaticSend:false}
      } finally {noDispatchProofs.delete(attemptId)}
    }
    if(delivery.deliveryDisposition==='accepted') {
      try {
        const resolution=run({...request,operation:'write',expectedGeneration:claim.generation,
          operationId:require('node:crypto').randomUUID(),
          entries:claim.entries.map(item=>item.envelopeId===entry.envelopeId?{...item,state:'accepted'}:item)},context)
        return {ok:resolution.ok,deliveryDisposition:'accepted',envelopeId:entry.envelopeId,attemptId,
          result:resolution.result,providerReceipt:delivery.result||null,reconcile:resolution.ok!==true,automaticSend:false}
      } catch(error) {
        return {ok:false,code:error?.code||'IMAGE_OUTBOX_WRITE_FAILED',deliveryDisposition:'accepted',
          envelopeId:entry.envelopeId,attemptId,reconcile:true,automaticSend:false}
      }
    }
    return {ok:false,code:delivery.code||'IMAGE_DELIVERY_UNKNOWN',deliveryDisposition:'unknown',
      envelopeId:entry.envelopeId,attemptId,generation:claim.generation,reconcile:true,automaticSend:false}
  }
  return Object.freeze({run,dispatch})
}
module.exports={createImageRetentionService}
