import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { parseAst } from 'rollup/parseAst'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createImageConversation } from '../../src/image-conversation.js'
import { sessionSafetyRefusal, sessionModelRefusal, sessionTurnStatus, sessionTurnSucceeded } from '../../src/agent-session-events.js'
import { QUEUE_PANEL } from '../../src/fleet-tree-copy.js'
import * as outbox from '../../src/session-outbox.js'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { fleetFetch, installWorld, mountView, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'
register('./css-loader.mjs', import.meta.url)
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const declaration = parseAst(source).body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'RunSessionNodes')
const Bindings = new Function('sessionSafetyRefusal', 'sessionModelRefusal', 'sessionTurnStatus', 'sessionTurnSucceeded', 'outboxMarkHeld', 'outboxClearHeld', `return (${source.slice(declaration.start, declaration.end)})`)(sessionSafetyRefusal, sessionModelRefusal, sessionTurnStatus, sessionTurnSucceeded, outbox.markHeld, outbox.clearHeld)
const packet = (sessionId, code) => ({ sessionId, event: { type: 'turn_completed', status: 'failed', payload: { failure: { code } } } })

for (const code of ['misalignmentPolicyViolation', 'misalignment_policy_violation']) {
  test(`queued text holds on every automatic door after ${code}`, async () => {
    const sessionId = 'queue-' + code, node = { id: 'node', sessionId }
    const bindings = new Bindings(); bindings.set(sessionId, node.id)
    bindings.recordAutomaticTurnBlock(packet(sessionId, code))
    const sends = []
    const scope = { sessionNodeIds: bindings, treeStore: { getNode: () => node, setNodeStatus() {} },
      destroyed:false, sessionModelOverride:new Map(), withResearchTreeBinding: bridge=>bridge,
      outboxConfirmDelivered:outbox.confirmDelivered, outboxMarkHeld:outbox.markHeld, transcriptAppend(){},broadcastOwnerMessage(){},turnLogAppend(){},
      setOrgStatus(){},refreshTree(){},currentRailTreeNode:null,
      outboxEnqueue: outbox.enqueue, outboxRequeueFront: outbox.requeueFront, outboxTakeNext: outbox.takeNext,
      QUEUE_PANEL,
      nodeBusy: () => false, pendingModelChoice: () => null, nodeReplacementFlight: { busy: () => false },
      recoveryCoordinator: () => null, nodeSessionEnded: () => false,
      window: { mcAgent: { send: request => sends.push(request) } } }
    const f = new Function(...Object.keys(scope), `${declaredFunctionSource(source, 'queueForSession')}\n${declaredFunctionSource(source, 'drainOutboxMessage')}\nreturn {queueForSession, drainOutboxMessage}`)(...Object.values(scope))
    try {
      const result = f.queueForSession(node, '  Retain these bytes\n  ')
      assert.equal(result.sentence, QUEUE_PANEL.cardQueued)
      assert.deepEqual(outbox.list(sessionId).map(row => row.text), [result.entry.text])
      await f.drainOutboxMessage(sessionId, node.id, outbox.takeNext(sessionId))
      assert.equal(outbox.list(sessionId)[0].heldReason, 'PROVIDER_SAFETY_REFUSAL')
      assert.equal(outbox.list(sessionId)[0].text, result.entry.text)
      assert.equal(sends.length, 0)
      bindings.recordAutomaticTurnBlock({sessionId, event:{type:'turn_completed',status:'completed'}})
      assert.equal(bindings.automaticTurnsHeld(sessionId), true, 'a later event cannot release retained work')
      bindings.delete(sessionId)
      assert.equal(bindings.automaticTurnsHeld(sessionId), false)
    } finally { outbox.clearSession(sessionId) }
  })
}

for (const code of ['misalignmentPolicyViolation', 'misalignment_policy_violation', 'host-block', null]) {
  test(`mounted Computers completion ${code || 'ordinary'} retains or drains the actual outbox`, async t => {
    const id = 'mounted-' + (code ? code.replace(/[^a-z]/g, '') : 'ordinary'), sessionId = id + '-session', computerId = id + '-computer'
    const world = await installWorld(fleetFetch({computerId}))
    let view
    t.after(() => { view?.destroy(); outbox.clearSession(sessionId); world.restore() })
    world.storage.setItem('mc.write.agent-session', 'enabled')
    seedTreeNode(world.storage, {computerId, nodeId:id, sessionId, status:'running'})
    const listeners = new Set(), sends = []
    let busy = code !== 'host-block'
    world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
    world.bridge.models = async () => ({provider:'codex', catalogSupported:true, models:[]})
    world.bridge.sessionActivity = async () => ({ok:true, busy, closing:false, ...(code === 'host-block' ? {lastTurnStatus:'failed',automaticTurnBlock:{code:'PROVIDER_SAFETY_REFUSAL',reason:'safety-policy'}} : {})})
    world.bridge.send = async request => { sends.push(request); return {ok:true, turnId:'next-turn'} }
    view = await mountView(world, {computerId})
    outbox.enqueue(sessionId, 'First retained text')
    outbox.enqueue(sessionId, 'Second retained text')
    for (const listener of listeners) await listener({sessionId,event:{type:'assistant_text_delta',turnId:'original-turn',text:'Synthetic reply'}})
    busy = false
    const event = code ? packet(sessionId,code === 'host-block' ? 'ordinary_failure' : code).event : {type:'turn_completed',status:'completed'}
    for (const listener of listeners) await listener({sessionId,event:{...event,turnId:'original-turn'}})
    await settle(15)
    assert.deepEqual(sends.map(row=>row.text), code ? [] : ['First retained text'])
    assert.deepEqual(outbox.list(sessionId).map(row=>row.text), code ? ['First retained text','Second retained text'] : ['Second retained text'])
    const node=JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId))).nodes.find(node=>node.id===id)
    assert.equal(node.status, code ? 'turn-failed' : 'running')
  })
}


for (const code of ['misalignmentPolicyViolation','misalignment_policy_violation']) {
 test(`Computers image readiness retains queued contents after ${code}`,async()=>{
  const sessionId='images-session',node={id:'images-node',sessionId,status:'finished'}
  const bindings=new Bindings();bindings.set(sessionId,node.id)
  const ownerContext={version:1,ownerId:'synthetic',currentEpoch:'synthetic-epoch',kind:'local'}
  const row={envelopeId:'held-image',state:'not-sent',text:'Synthetic retained picture',imageReceipts:[{manifestHash:'synthetic-manifest'}]}
  const calls=[]
  const bridge={ownerContext:async()=>ownerContext,onOwnerContextChanged:()=>()=>{},imageQueue:async request=>{
   calls.push(request)
   if(request.operation==='binding')return {ok:true,result:{sessionId,conversationId:'synthetic-conversation',ownerContext}}
   if(request.operation==='read')return {ok:true,operation:'read',result:{version:1,generation:'g1',destinationSessionId:sessionId,entries:[structuredClone(row)],automaticSend:false}}
   if(request.operation==='preview')return {ok:false,code:'IMAGE_PREVIEW_UNAVAILABLE'}
   assert.fail('automatic image dispatch after safety refusal')
  }}
  let ready
  const scope={treeStore:{getNode:()=>node},window:{mcAgent:bridge},imageConversations:new Map(),destroyed:false,
   sessionNodeIds:bindings,createImageConversation,nodeBusy:()=>false,nodeSessionEnded:()=>false,pendingModelChoice:()=>null,
   pendingModelDrainHolds:new Set(),nodeCleanupPending:()=>false,nodeReplacementFlight:{busy:()=>false},
   recoveryPausedNode:()=>false,registerNodeStatusListener:(_id,listener)=>{ready=listener;return()=>{}}}
  const conversation=new Function(...Object.keys(scope),declaredFunctionSource(source,'imageConversationFor')+';return imageConversationFor')(...Object.values(scope))(node.id)
  try {
   await conversation.refresh()
   bindings.recordAutomaticTurnBlock(packet(sessionId,code))
   ready();await conversation.signalReady();await settle(2)
   assert.equal(calls.filter(r=>r.operation==='dispatch').length,0)
   const retained=(await conversation.refresh()).entries[0]
   assert.equal(retained.text,row.text)
   assert.deepEqual(retained.imageReceipts,row.imageReceipts)
  }finally{conversation.dispose()}
 })
}

/* 1.0.50 REVIEW-1050 #9. While the account-recovery coordinator holds a node at its account's usage limit
   (externalBlock, the fourth gate on queued words), the node's picture queue waited only for safety and model
   holds, so a queued picture message went to the spent account on the next readiness notice. */
test('Computers image readiness retains queued pictures while the node is held at an account limit', async () => {
  const sessionId = 'limit-images-session', node = { id: 'limit-images-node', sessionId, status: 'finished' }
  const bindings = new Bindings(); bindings.set(sessionId, node.id)
  const ownerContext = { version: 1, ownerId: 'synthetic', currentEpoch: 'synthetic-epoch', kind: 'local' }
  const row = { envelopeId: 'held-image', state: 'not-sent', text: 'Synthetic retained picture', imageReceipts: [{ manifestHash: 'synthetic-manifest' }] }
  const calls = []
  const bridge = { ownerContext: async () => ownerContext, onOwnerContextChanged: () => () => {}, imageQueue: async request => {
    calls.push(request)
    if (request.operation === 'binding') return { ok: true, result: { sessionId, conversationId: 'synthetic-conversation', ownerContext } }
    if (request.operation === 'read') return { ok: true, operation: 'read', result: { version: 1, generation: 'g1', destinationSessionId: sessionId, entries: [structuredClone(row)], automaticSend: false } }
    if (request.operation === 'preview') return { ok: false, code: 'IMAGE_PREVIEW_UNAVAILABLE' }
    if (request.operation === 'dispatch') return { ok: false, code: 'SYNTHETIC_DISPATCH_REFUSED' }
    return { ok: false, code: 'SYNTHETIC_UNEXPECTED' }
  } }
  const blocked = new Set([node.id])
  let ready
  const scope = { treeStore: { getNode: () => node }, window: { mcAgent: bridge }, imageConversations: new Map(), destroyed: false,
    sessionNodeIds: bindings, createImageConversation, nodeBusy: () => false, nodeSessionEnded: () => false, pendingModelChoice: () => null,
    pendingModelDrainHolds: new Set(), nodeCleanupPending: () => false, nodeReplacementFlight: { busy: () => false },
    recoveryCoordinator: () => ({ externalBlock: id => ({ blocked: blocked.has(id) }) }),
    recoveryPausedNode: () => false, registerNodeStatusListener: (_id, listener) => { ready = listener; return () => {} } }
  const conversation = new Function(...Object.keys(scope), declaredFunctionSource(source, 'imageConversationFor') + ';return imageConversationFor')(...Object.values(scope))(node.id)
  try {
    await conversation.refresh()
    ready(); await conversation.signalReady(); await settle(2)
    assert.equal(calls.filter(r => r.operation === 'dispatch').length, 0, 'a queued picture went to the account at its usage limit')
    // The coordinator lifts the block: the next readiness notice lets the picture go.
    blocked.clear()
    ready(); await conversation.signalReady(); await settle(2)
    assert.equal(calls.filter(r => r.operation === 'dispatch').length > 0, true)
  } finally { conversation.dispose() }
})

/* 1.0.50 review CM-2. After the provider refuses the session's model, queued words are held (not sent to be refused
   again), the row says why, a safety hold is never downgraded to it, and a successful turn releases it. */
const modelRefused = sessionId => ({ sessionId, event: { type: 'turn_completed', status: 'failed', text: 'Codex refused this model: no access.',
  payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: 'Codex refused this model: no access.', category: 'model-refused' } } } })

test('a model refusal holds queued words until a turn succeeds, and never replaces a safety hold', () => {
  const sessionId = 'model-held', bindings = new Bindings(); bindings.set(sessionId, 'node')
  try {
    outbox.enqueue(sessionId, 'Synthetic waiting words')
    bindings.recordAutomaticTurnBlock(modelRefused(sessionId))
    assert.equal(bindings.automaticTurnHoldCode(sessionId), 'PROVIDER_MODEL_REFUSED')
    assert.equal(outbox.list(sessionId)[0].heldReason, 'PROVIDER_MODEL_REFUSED')
    assert.match(QUEUE_PANEL.heldReasons.PROVIDER_MODEL_REFUSED, /refused this agent’s model/)
    bindings.recordAutomaticTurnBlock({ sessionId, event: { type: 'turn_completed', status: 'error' } })
    assert.equal(bindings.automaticTurnsHeld(sessionId), true, 'a failed turn does not release the hold')
    bindings.recordAutomaticTurnBlock({ sessionId, event: { type: 'turn_completed', status: 'completed' } })
    assert.equal(bindings.automaticTurnsHeld(sessionId), false, 'a successful turn releases the hold')
    assert.equal(outbox.list(sessionId)[0].heldReason, undefined)
    assert.equal(outbox.list(sessionId)[0].text, 'Synthetic waiting words')
    bindings.recordAutomaticTurnBlock(packet(sessionId, 'misalignmentPolicyViolation'))
    bindings.recordAutomaticTurnBlock(modelRefused(sessionId))
    assert.equal(bindings.automaticTurnHoldCode(sessionId), 'PROVIDER_SAFETY_REFUSAL')
    bindings.recordAutomaticTurnBlock({ sessionId, event: { type: 'turn_completed', status: 'completed' } })
    assert.equal(bindings.automaticTurnHoldCode(sessionId), 'PROVIDER_SAFETY_REFUSAL')
  } finally { outbox.clearSession(sessionId) }
})

for (const host of [false, true]) {
  test(`mounted Computers holds the queue after a model refusal${host ? ' reported by the host on reconnect' : ''}, and a successful turn drains it`, async t => {
    const id = 'mounted-model' + (host ? 'host' : ''), sessionId = id + '-session', computerId = id + '-computer'
    const world = await installWorld(fleetFetch({computerId}))
    let view
    t.after(() => { view?.destroy(); outbox.clearSession(sessionId); world.restore() })
    world.storage.setItem('mc.write.agent-session', 'enabled')
    seedTreeNode(world.storage, {computerId, nodeId:id, sessionId, status:'running'})
    const listeners = new Set(), sends = []
    let busy = !host
    world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
    world.bridge.models = async () => ({provider:'codex', catalogSupported:true, models:[]})
    world.bridge.sessionActivity = async () => ({ok:true, busy, closing:false, ...(host ? {lastTurnStatus:'failed',automaticTurnBlock:{code:'PROVIDER_MODEL_REFUSED',reason:'model-refused'}} : {})})
    world.bridge.send = async request => { sends.push(request); return {ok:true, turnId:'next-turn'} }
    view = await mountView(world, {computerId})
    outbox.enqueue(sessionId, 'First retained text')
    outbox.enqueue(sessionId, 'Second retained text')
    const emit = async event => { for (const listener of listeners) await listener({sessionId, event}) }
    await emit({type:'assistant_text_delta',turnId:'original-turn',text:'Synthetic reply'})
    busy = false
    await emit(host ? {type:'turn_completed',status:'failed',turnId:'original-turn',payload:{failure:{code:'ordinary_failure'}}}
      : {...modelRefused(sessionId).event, turnId:'original-turn'})
    await settle(15)
    assert.deepEqual(sends.map(row=>row.text), [], 'nothing queued is sent to a refused model')
    assert.deepEqual(outbox.list(sessionId).map(row=>row.text), ['First retained text','Second retained text'])
    await emit({type:'assistant_text_delta',turnId:'person-turn',text:'Answered on another model'})
    await emit({type:'turn_completed',status:'completed',turnId:'person-turn'})
    await settle(15)
    assert.deepEqual(sends.map(row=>row.text), ['First retained text'], 'the first held message goes once a turn succeeds')
    assert.deepEqual(outbox.list(sessionId).map(row=>row.text), ['Second retained text'])
  })
}
