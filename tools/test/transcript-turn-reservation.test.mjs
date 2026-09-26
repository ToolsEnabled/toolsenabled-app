import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createAgentHost } from '../../shell/agent-host.cjs'
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createTranscriptRecoveryJournal } = require('../../shell/transcript-recovery-journal.cjs')
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) { for (let i=0; i<200 && !predicate(); i++) await tick(); assert.ok(predicate(), 'expected inert boundary was reached') }
const missing = () => Object.assign(new Error('No inert sidecar'), { code:'ENOENT' })

async function fixture(t, { capacity=2*1024*1024, provider=null, cleanup=()=>{}, afterReserve=async()=>{} }={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'te-turn-reserve-'))
  t.diagnostic('RETAINED_TURN_RESERVATION_FIXTURE '+directory)
  let primaryFull=false, journalFull=false, sends=0, accepted=0
  const notices=[], reservations=[], captures=[], notice=Promise.withResolvers()
  const journalIo={...fs,open:async (...args)=>{
    const handle=await fs.open(...args)
    if(args[1]!=='r+') return handle
    return { close:()=>handle.close(),sync:()=>handle.sync(),write:async (...parts)=>{
      if(journalFull) throw Object.assign(new Error('Synthetic journal unavailable'),{code:'ENOSPC'})
      return handle.write(...parts)
    }}
  }}
  const journal=createTranscriptRecoveryJournal({directory:path.join(directory,'recovery'),capacityBytes:capacity,io:journalIo})
  await journal.ready
  const store=createNodeTranscriptStore({directory,recoveryJournal:journal,onStorageError:error=>{notices.push(error);notice.resolve(error)}, 
    io:{...fs,unlink:async()=>{throw missing()},writeFile:async(...args)=>{
      if(primaryFull) throw Object.assign(new Error('Synthetic transcript full'),{code:'ENOSPC'})
      return fs.writeFile(...args)
    }}
  })
  const capture=createNodeTranscriptCapture({store})
  const bindings=new Map(['a','b'].map(id=>[id,{sessionId:'reservation-'+id,computerId:'inert-computer',nodeId:'inert-node-'+id}]))
  for(const binding of bindings.values()) capture.bind(binding)
  t.mock.method(engine,'startCodexSession',async options=>({
    threadId:'thread-'+options.sessionId, close(){}, adapter:{
      sendTurn(request){sends++;return provider?provider(request,sends):{turnId:'turn-'+sends}},
      async interrupt(){},answerApproval(){},
    }
  }))
  const host=createAgentHost({enginePath,defaultCwd:directory,profileRoot:path.parse(directory).root,
    freeMemory:()=>64*1024**3,
    confinementPlanner:()=>({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{}}),
    assertTranscriptWritable:()=>store.assertWritable(),
    reserveTranscriptTurn:async request=>{
      const binding=[...bindings.values()].find(item=>item.sessionId===request.sessionId)
      const lease=await store.reserveTurn({...request,...binding})
      reservations.push(lease)
      await afterReserve({host,store,request,lease})
      return lease
    },
  })
  host.onAcceptedPrompt(request=>{
    accepted++
    const pending=capture.recordAcceptedTranscriptSend(request)
    captures.push(pending)
    return pending
  })
  for(const binding of bindings.values()) await host.startSession({sessionId:binding.sessionId})
  t.after(async()=>{await cleanup();primaryFull=false;journalFull=false;await store.retry();await capture.retry({durable:true});await Promise.allSettled(captures);await host.closeAll();await journal.close()})
  return {host,store,capture,journal,bindings,notices,reservations,directory,noticed:notice.promise,
    fail(primary,journalFailure){primaryFull=primary;journalFull=journalFailure},
    sends:()=>sends,accepted:()=>accepted,
    request:(which='a',text='Synthetic message.')=>({sessionId:bindings.get(which).sessionId,text,origin:'person'}),
  }
}

test('real host refuses a turn whose journal reservation cannot fit before provider acceptance',async t=>{
  const f=await fixture(t,{capacity:1024})
  const request=f.request('a','Unsent words '.repeat(250)),original=structuredClone(request)
  await assert.rejects(f.host.sendTurn(request),error=>/RECOVERY|STORAGE|DISK/.test(error.code||''))
  assert.equal(f.sends(),0,'no provider may receive a turn without its reserved capacity')
  assert.equal(f.accepted(),0)
  assert.deepEqual(request,original,'the composer request stays untouched')
  assert.equal(f.store.getStorageStatus().pendingTurns||0,0)
  assert.match(f.notices.at(-1)?.message||'',/not sent|unsent/i)
})

test('a single pending turn admission refuses concurrent dispatch until its accepted transcript publishes',async t=>{
  const ack=Promise.withResolvers(),entered=Promise.withResolvers()
  const f=await fixture(t,{cleanup:()=>ack.resolve({turnId:'first'}),provider:async(request,count)=>{if(count===1){entered.resolve();return ack.promise}return{turnId:'turn-'+count}}})
  let first
  t.after(async()=>{ack.resolve({turnId:'first'});await Promise.allSettled([first])})
  first=f.host.sendTurn(f.request())
  first.catch(()=>{})
  await entered.promise
  assert.equal(f.store.getStorageStatus().pendingTurns,1)
  await assert.rejects(f.host.sendTurn(f.request('b','Must wait before dispatch.')),
    error=>error.code==='MC_TRANSCRIPT_ADMISSION_PENDING')
  assert.equal(f.sends(),1)
  ack.resolve({turnId:'first'})
  await first
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  await f.host.sendTurn(f.request('b','May dispatch after publication.'))
  assert.equal(f.sends(),2)
  assert.equal(f.journal.reservedBytes,0)
})

test('only the accepted unpublished turn is RAM-only and its retained notice, pause and retry are explicit',async t=>{
  const f=await fixture(t)
  f.fail(true,true)
  const text='Unsaved accepted message. '.repeat(4000)
  const before=process.memoryUsage().rss
  let completed=false
  const first=f.host.sendTurn(f.request('a',text)).then(()=>{completed=true})
  await f.noticed
  await tick()
  assert.equal(completed,false,'the producer acknowledgement is held by the save boundary')
  assert.equal(f.accepted(),1)
  assert.equal(f.store.getStorageStatus().pendingTurns,1)
  assert.equal(f.store.getStorageStatus().recoverable,false)
  assert.match(f.notices.at(-1)?.message||'',/last message.*unsaved/i)
  await assert.rejects(f.host.sendTurn(f.request('b','Unsent second message.')))
  assert.equal(f.sends(),1,'new turns remain unaccepted')
  const page=await f.store.read(f.bindings.get('a'))
  assert.equal(page.entries.find(row=>row.text===text)?.text,text)
  assert.ok(page.retainedBytes<=f.reservations[0].reservedBytes,'the reserved estimate covers the retained accepted input')
  const rssDelta=Math.max(0,process.memoryUsage().rss-before)
  const rssBudget=f.reservations[0].reservedBytes+32*1024*1024
  assert.ok(rssDelta<rssBudget,'bounded inert input stays inside reservation plus parser/copy allowance')
  t.diagnostic(JSON.stringify({scope:'single-inert-accepted-turn',reservationBytes:f.reservations[0].reservedBytes,retainedBytes:page.retainedBytes,rssDelta,rssBudget}))
  await assert.rejects(f.store.shutdown(),/unsaved|disk|storage/i)
  f.fail(false,false)
  assert.equal((await f.store.retry()).durable,true)
  assert.equal((await f.capture.retry({durable:true})).durable,true)
  await first
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  assert.equal(f.store.getStorageStatus().durable,true)
  assert.equal(f.journal.reservedBytes,0)
  assert.equal((await f.store.read(f.bindings.get('a'))).entries.filter(row=>row.text===text).length,1)
})

test('closing before provider dispatch releases unused reservation without accepted history',async t=>{
  let close=true
  const f=await fixture(t,{afterReserve:async({host,request})=>{
    if(close)await host.closeSession({sessionId:request.sessionId})
  }})
  const result=await f.host.sendTurnTracked(f.request())
  assert.equal(result.ok,false)
  assert.equal(result.deliveryDisposition,'not-sent')
  assert.equal(f.sends(),0)
  assert.equal(f.accepted(),0)
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  assert.equal(f.journal.reservedBytes,0)
  close=false
  await f.host.sendTurn(f.request('b'))
  assert.equal(f.accepted(),1)
})

test('the real main reservation hook uses authoritative capture ownership before dispatch',async()=>{
  const vm=await import('node:vm')
  const main=await fs.readFile(new URL('../../shell/main.cjs',import.meta.url),'utf8')
  const begin=main.indexOf('    reserveTranscriptTurn: async request => {')
  const end=main.indexOf('    providerSignIn:',begin)
  assert.ok(begin>=0&&end>begin,'the actual host configuration must supply reservation admission')
  const calls=[]
  let owned=true
  const context={assertConversationWritable:async()=>calls.push('writable'),
    transcriptCapture:{bindingFor:id=>owned?{sessionId:id,computerId:'owned-computer',nodeId:'owned-node'}:null},
    nodeTranscripts:{reserveTurn:async request=>{calls.push(request);return{reservationId:'owned',reservedBytes:65536}}}}
  const config=vm.runInNewContext('({'+main.slice(begin,end)+'})',context)
  const request={sessionId:'owned-session',text:'Exact unsent text.',nodeId:'forged-node'}
  assert.equal((await config.reserveTranscriptTurn(request)).reservationId,'owned')
  assert.equal(calls[0],'writable')
  assert.equal(calls[1].nodeId,'owned-node')
  assert.equal(calls[1].text,request.text)
  owned=false
  await assert.rejects(config.reserveTranscriptTurn(request),{code:'MC_TRANSCRIPT_IDENTITY_UNRESOLVED'})
  assert.equal(calls.filter(value=>typeof value==='object').length,1,'an unbound turn reserves nothing')
})

test('a published input releases its claim and later output can still enter recovery storage',async t=>{
  const f=await fixture(t)
  await f.host.sendTurn(f.request('a','Durably accepted input.'))
  assert.equal(f.journal.reservedBytes,0)
  f.fail(true,false)
  const pending=f.capture.packet({sessionId:f.bindings.get('a').sessionId,
    event:{type:'assistant_text_delta',turnId:'turn-1',text:'Output after the input was saved.'}})
  await f.noticed
  assert.equal(f.store.getStorageStatus().recoverable,true,'a released input claim must not poison a later output journal write')
  f.fail(false,false)
  await f.store.retry()
  await f.capture.retry({durable:true})
  await pending
  assert.equal((await f.store.read(f.bindings.get('a'))).entries.find(row=>row.who==='agent').text,
    'Output after the input was saved.')
})

test('reservation preparation is visible to quit before its first asynchronous storage read', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'te-turn-reserve-preparation-'))
  t.diagnostic('RETAINED_TURN_RESERVATION_FIXTURE '+directory)
  const ready=Promise.withResolvers()
  const real=createTranscriptRecoveryJournal({directory:path.join(directory,'recovery'),capacityBytes:1024*1024})
  await real.ready
  const journal={ready:ready.promise,load:()=>real.load(),reserve:(...args)=>real.reserve(...args),
    releaseReservation:(...args)=>real.releaseReservation(...args)}
  const store=createNodeTranscriptStore({directory,recoveryJournal:journal})
  const request={sessionId:'pending',computerId:'computer',nodeId:'node',text:'Unsent until reserved.'}
  const pending=store.reserveTurn(request)
  t.after(async()=>{ready.resolve();const claim=await pending;await claim.release();await real.close()})
  assert.equal(store.getStorageStatus().pendingTurns,1,'quit must see admission before journal.ready settles')
  await assert.rejects(store.reserveTurn({...request,nodeId:'second'}),{code:'MC_TRANSCRIPT_ADMISSION_PENDING'})
  ready.resolve()
  const claim=await pending
  await claim.release()
  assert.equal(store.getStorageStatus().pendingTurns,0)
})

test('closing before provider dispatch cancels unused capacity despite another storage failure', async t => {
  const ready=Promise.withResolvers(),entered=Promise.withResolvers()
  const f=await fixture(t,{cleanup:()=>ready.resolve(),
    afterReserve:async({host,request})=>{entered.resolve();await ready.promise;await host.closeSession({sessionId:request.sessionId})}})
  const pending=f.host.sendTurnTracked(f.request())
  await entered.promise
  f.fail(true,false)
  await f.store.append({...f.bindings.get('b'),entries:[{id:'other-failure',who:'agent',text:'Held unrelated output.'}]},{accepted:true})
  ready.resolve()
  const result=await pending
  assert.equal(result.deliveryDisposition,'not-sent')
  assert.equal(f.sends(),0)
  assert.equal(f.accepted(),0)
  assert.equal(f.store.getStorageStatus().pendingTurns,0,'unused capacity may be cancelled before dispatch')
  assert.equal(f.journal.reservedBytes,0)
  assert.equal(f.store.getStorageStatus().durable,false,'cancel never clears another write failure')
  f.fail(false,false)
  await f.store.retry()
  await f.capture.retry({durable:true})
  assert.equal(f.store.getStorageStatus().durable,true)
})

test('failed reservation cleanup remains visible and explicit retry releases its exact claim', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'te-turn-reserve-cleanup-'))
  t.diagnostic('RETAINED_TURN_RESERVATION_FIXTURE '+directory)
  const real=createTranscriptRecoveryJournal({directory:path.join(directory,'recovery'),capacityBytes:1024*1024})
  await real.ready
  let full=true,releaseFails=true,store
  const other={computerId:'computer',nodeId:'other',entries:[{id:'held',who:'agent',text:'Concurrent accepted output.'}]}
  const journal={ready:real.ready,load:()=>real.load(),put:(...args)=>real.put(...args),remove:(...args)=>real.remove(...args),
    reserve:async(...args)=>{const answer=await real.reserve(...args);await store.append(other,{accepted:true});return answer},
    releaseReservation:(...args)=>{if(releaseFails)throw Object.assign(new Error('Synthetic release failure'),{code:'EIO'});return real.releaseReservation(...args)}}
  store=createNodeTranscriptStore({directory,recoveryJournal:journal,io:{...fs,unlink:async()=>{throw missing()},
    writeFile:(...args)=>{if(full)throw Object.assign(new Error('Synthetic disk full'),{code:'ENOSPC'});return fs.writeFile(...args)}}})
  t.after(async()=>{full=false;releaseFails=false;await store.retry();await real.close()})
  await assert.rejects(store.reserveTurn({sessionId:'never-dispatched',computerId:'computer',nodeId:'node',text:'Still in composer.'}))
  assert.equal(store.getStorageStatus().pendingTurns,1,'failed cleanup cannot erase the tracked claim')
  assert.ok(real.reservedBytes>0)
  full=false
  assert.equal((await store.retry()).ok,false,'failed cleanup remains an explicit retry refusal')
  assert.equal(store.getStorageStatus().pendingTurns,1)
  releaseFails=false
  assert.equal((await store.retry()).durable,true)
  assert.equal(store.getStorageStatus().pendingTurns,0)
  assert.equal(real.reservedBytes,0)
})

test('host drains its send tracking when unused reservation release fails, then storage retry recovers', async t => {
  const f=await fixture(t,{afterReserve:async({host,request})=>host.closeSession({sessionId:request.sessionId})})
  const original=f.journal.releaseReservation.bind(f.journal)
  let refuse=true
  t.mock.method(f.journal,'releaseReservation',async(...args)=>{
    if(refuse)throw Object.assign(new Error('Synthetic claim release failure'),{code:'EIO'})
    return original(...args)
  })
  t.after(()=>{refuse=false})
  const result=await f.host.sendTurnTracked(f.request())
  assert.equal(result.deliveryDisposition,'not-sent')
  assert.equal(f.sends(),0)
  assert.equal(f.accepted(),0)
  assert.equal(f.host.hasPendingTranscriptAdmissions(),false,'a rejected release must not leave a settled host promise registered forever')
  assert.equal(f.store.getStorageStatus().pendingTurns,1,'storage owns unresolved claim cleanup')
  assert.match(f.store.getStorageStatus().storageError?.message||'',/not sent|unsent/i)
  refuse=false
  await f.store.retry()
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  assert.equal(f.host.hasPendingTranscriptAdmissions(),false)
})

test('a synchronous post-dispatch throw preserves unconfirmed words without announcing acceptance', async t => {
  const f=await fixture(t,{provider:()=>{throw Object.assign(new Error('Transport failed after its write'),{code:'EPIPE'})}})
  const request=f.request('a','The provider may already hold these exact words.')
  const result=await f.host.sendTurnTracked(request)
  assert.equal(result.ok,false)
  assert.equal(result.deliveryDisposition,'unknown')
  assert.equal(f.sends(),1)
  assert.equal(f.accepted(),0,'uncertain delivery is never promoted to provider acceptance')
  const page=await f.store.read(f.bindings.get('a'))
  const record=page.entries.find(row=>row.deliveryDisposition==='unknown')
  assert.ok(record,'the reserved unknown delivery must survive in visible recovery history')
  assert.equal(record.who,'action')
  assert.match(record.tool,/unconfirmed/i)
  assert.equal(record.uncertainSend.text,request.text)
  assert.equal(record.uncertainSend.transcriptPrompt.text,request.text)
  assert.equal(record.body,request.text)
  assert.equal(page.entries.filter(row=>row.who==='you').length,0)
  assert.equal(f.store.getStorageStatus().pendingTurns,0,'only durable unknown publication permits release')
  assert.equal(f.journal.reservedBytes,0)
})

test('unknown delivery on a full disk keeps one reserved message until explicit storage retry saves it', async t => {
  const failed=Promise.withResolvers()
  const f=await fixture(t,{provider:()=>failed.promise})
  const request={...f.request('a','Exact uncertain words with a picked image.'),images:[{path:'/inert/selected.png'}],
    acceptedAttachmentSummaries:[{name:'selected.png',bytes:23}]}
  const pending=f.host.sendTurnTracked(request)
  await until(()=>f.sends()===1)
  f.fail(true,true)
  failed.reject(Object.assign(new Error('Connection ended without an acknowledgement'),{code:'EPIPE'}))
  const result=await pending
  assert.equal(result.deliveryDisposition,'unknown')
  assert.equal(f.accepted(),0)
  assert.equal(f.store.getStorageStatus().pendingTurns,1,'no acknowledgement is not permission to cancel')
  assert.ok(f.journal.reservedBytes>0)
  assert.equal(f.store.getStorageStatus().recoverable,false)
  assert.match(f.notices.at(-1)?.message||'',/last message.*unsaved/i)
  const record=(await f.store.read(f.bindings.get('a'))).entries.find(row=>row.deliveryDisposition==='unknown')
  assert.equal(record?.uncertainSend.text,request.text)
  assert.deepEqual(record.uncertainSend.attachments,[{name:'selected.png',bytes:23}])
  assert.equal(JSON.stringify(record).includes('/inert/'),false,'no picked path becomes transcript metadata')
  await assert.rejects(f.host.sendTurn(f.request('b')))
  assert.equal(f.sends(),1)
  await assert.rejects(f.store.shutdown(),/unsaved|disk|storage/i)
  assert.equal((await f.store.retry()).ok,false)
  assert.equal(f.store.getStorageStatus().pendingTurns,1)
  f.fail(false,false)
  assert.equal((await f.store.retry()).durable,true)
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  assert.equal(f.journal.reservedBytes,0)
  assert.equal(f.sends(),1,'retry saves only; it never repeats an uncertain dispatch')
  const restored=(await f.store.read(f.bindings.get('a'))).entries.filter(row=>row.deliveryDisposition==='unknown')
  assert.equal(restored.length,1)
  assert.equal(restored[0].uncertainSend.text,request.text)
  const reopened=createNodeTranscriptStore({directory:f.directory})
  assert.equal((await reopened.read(f.bindings.get('a'))).entries.find(row=>row.deliveryDisposition==='unknown').uncertainSend.text,request.text)
})

test('an accepted observer rejection cannot strand a published transcript reservation', async t => {
  const f=await fixture(t)
  f.host.onAcceptedPrompt(()=>{throw Object.assign(new Error('Synthetic observer failure'),{code:'OBSERVER_FAILED'})})
  const result=await f.host.sendTurnTracked(f.request('a','Accepted and durably saved despite observer failure.'))
  assert.equal(result.ok,false)
  assert.equal(result.code,'OBSERVER_FAILED')
  assert.equal(f.accepted(),1)
  await f.store.retry()
  assert.equal(f.store.getStorageStatus().pendingTurns,0,'an observer failure must not strand saved custody')
  assert.equal(f.journal.reservedBytes,0)
  assert.equal(f.host.hasPendingTranscriptAdmissions(),false)
  assert.equal((await f.store.read(f.bindings.get('a'))).entries.filter(row=>row.who==='you').length,1)
})

test('observer failure waits for refused canonical capture then releases after saving retry', async t => {
  const f=await fixture(t)
  f.host.onAcceptedPrompt(()=>Promise.reject(Object.assign(new Error('Observer failed after acceptance'),{code:'OBSERVER_FAILED'})))
  f.fail(true,true)
  let settled=false
  const pending=f.host.sendTurnTracked(f.request('a','One accepted unsaved message.')).then(result=>{settled=true;return result})
  await f.noticed
  await tick()
  assert.equal(settled,false,'an observer cannot let the host abandon its canonical capture boundary')
  assert.equal(f.store.getStorageStatus().pendingTurns,1)
  assert.equal(f.accepted(),1)
  f.fail(false,false)
  await f.store.retry()
  await f.capture.retry({durable:true})
  const result=await pending
  assert.equal(result.code,'OBSERVER_FAILED')
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  assert.equal(f.journal.reservedBytes,0)
  assert.equal((await f.store.read(f.bindings.get('a'))).entries.filter(row=>row.who==='you').length,1)
})

test('closed transcript ownership refuses host reservation preparation', async t => {
  const f=await fixture(t)
  await f.store.append({...f.bindings.get('a'),entries:[],metadata:{closed:true}})
  let lease,error
  try { lease=await f.store.reserveTurn({...f.request('a','Closed ownership must not accept this.'),...f.bindings.get('a')}) }
  catch(refusal) { error=refusal }
  if(lease)await lease.release({accepted:false})
  assert.ok(error,'closed transcript ownership must refuse before the host dispatch boundary')
  assert.equal(f.sends(),0)
  assert.equal(f.accepted(),0)
  assert.equal(f.store.getStorageStatus().pendingTurns,0)
  assert.equal(f.journal.reservedBytes,0)
})

test('a published uncertain delivery reopens from the journal without asserting provider acceptance', async t => {
  const ack=Promise.withResolvers()
  const f=await fixture(t,{provider:()=>ack.promise})
  const request=f.request('a','Exact unconfirmed message restored from recovery.')
  const pending=f.host.sendTurnTracked(request)
  await until(()=>f.sends()===1)
  f.fail(true,false)
  ack.reject(Object.assign(new Error('No acknowledgement after dispatch'),{code:'EPIPE'}))
  const result=await pending
  assert.equal(result.deliveryDisposition,'unknown')
  assert.equal(f.accepted(),0)
  assert.equal(f.store.getStorageStatus().recoverable,true)
  assert.equal(f.store.getStorageStatus().pendingTurns,1)
  const journal=createTranscriptRecoveryJournal({directory:path.join(f.directory,'recovery'),capacityBytes:2*1024*1024})
  await journal.ready
  const reopened=createNodeTranscriptStore({directory:f.directory,recoveryJournal:journal})
  await assert.rejects(reopened.assertWritable(),{code:'MC_TRANSCRIPT_DISK_FULL'})
  const entries=(await reopened.read(f.bindings.get('a'))).entries
  assert.equal(entries.filter(row=>row.who==='you').length,0)
  assert.equal(entries.find(row=>row.deliveryDisposition==='unknown')?.uncertainSend.text,request.text)
  assert.equal(f.sends(),1)
  await journal.close()
})
