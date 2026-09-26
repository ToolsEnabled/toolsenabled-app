import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const modulePath = resolve(process.env.IMAGE_OUTBOX_MODULE || fileURLToPath(new URL('../../shell/image-outbox.cjs', import.meta.url)))
const { createImageOutbox: create, LIMITS } = require(modulePath)
const { createDurableImageCustody } = require('../../shell/durable-image-custody.cjs')
assert.ok(process.env.IMAGE_TEST_TEMP, 'IMAGE_TEST_TEMP must be an explicit fenced test directory')
const temp = realpathSync(process.env.IMAGE_TEST_TEMP)
const scratch = () => mkdtempSync(join(temp, 'image-outbox-current-'))
const context = { productOwnerId: 'owner-a', epoch: 1 }
const authenticate = c => ({ authenticated: c?.epoch === 1, productOwnerId: c?.productOwnerId })
const entry = overrides => ({ envelopeId: randomUUID(), text: ' waiting words ', imageReceipts: [], state: 'not-sent', ...overrides })
const options = root => ({ root, conversationId: 'conversation-a', authenticate, validateReceipt: () => 1 })
const save = (store, entries, generation = null, operationId = randomUUID()) => store.write({ expectedGeneration: generation, operationId, entries }, context)
test('CAS stale ABA and competing instances retain prior data', () => {
  const root = scratch(); const a = create(options(root)); const b = create(options(root))
  const empty = a.read(context)
  const one = save(a, [entry()])
  assert.throws(() => save(b, [], empty.generation), { code: 'IMAGE_OUTBOX_STALE' })
  const cancelled = b.cancel({expectedGeneration:one.generation,operationId:randomUUID(),envelopeIds:[one.entries[0].envelopeId]},context)
  const two = b.retireAccepted({expectedGeneration:cancelled.generation,operationId:randomUUID(),envelopeIds:[one.entries[0].envelopeId]},context)
  assert.notEqual(two.generation, empty.generation)
  assert.throws(() => save(a, [entry()], empty.generation), { code: 'IMAGE_OUTBOX_STALE' })
  assert.deepEqual(a.read(context), two)
})
test('operation retry is idempotent even after later writes; changed retry refuses', () => {
  const store = create(options(scratch())); const entries = [entry()]; const operationId = randomUUID()
  const one = save(store, entries, null, operationId)
  save(store, entries.map(e=>({...e,state:'unknown'})), one.generation)
  assert.deepEqual(save(store, entries, null, operationId), one)
  assert.throws(() => save(store, [], null, operationId), { code: 'IMAGE_OUTBOX_IDEMPOTENCY_CONFLICT' })
})
test('same envelope identity survives removal; accepted and unknown never auto replay', () => {
  const store = create(options(scratch())); const first = entry()
  let result = save(store, [first])
  assert.throws(() => save(store, [{ ...first, text: 'changed' }], result.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  result = save(store, [{ ...first, state: 'unknown' }], result.generation)
  assert.throws(() => save(store, [first], result.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  assert.throws(() => save(store, [], result.generation), { code: 'IMAGE_OUTBOX_OMISSION_REFUSED' })
  result = save(store, [{ ...first, state: 'accepted' }], result.generation)
  assert.throws(() => save(store, [{ ...first, state: 'unknown' }], result.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  result=store.retireAccepted({expectedGeneration:result.generation,operationId:randomUUID(),envelopeIds:[first.envelopeId]},context)
  assert.throws(() => save(store, [first], result.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  assert.equal(store.read(context).automaticSend, false)
})
test('owner conversation and epoch isolation', () => {
  const root = scratch(); const store = create(options(root)); save(store, [entry()])
  assert.throws(() => store.read({ ...context, productOwnerId: 'owner-b' }), { code: 'IMAGE_OUTBOX_OWNER' })
  assert.throws(() => store.read({ ...context, epoch: 2 }), { code: 'IMAGE_OUTBOX_AUTH_REQUIRED' })
  assert.throws(() => create({ ...options(root), conversationId: 'conversation-b' }).read(context), { code: 'IMAGE_OUTBOX_OWNER' })
})
test('incomplete revision reports itself while preserving previous snapshot', () => {
  const root = scratch(); const store = create(options(root)); const one = save(store, [entry()])
  mkdirSync(join(root, '1'))
  const read = store.read(context)
  assert.deepEqual(read.entries, one.entries)
  assert.equal(read.writeBlocked, 'IMAGE_OUTBOX_INCOMPLETE')
  assert.throws(() => save(store, [], one.generation), { code: 'IMAGE_OUTBOX_INCOMPLETE' })
})
test('snapshot corruption refuses distinctly from absent store', () => {
  const root = scratch(); const store = create(options(root))
  assert.equal(store.read(context).generation, null)
  save(store, [entry()])
  const file = join(root, '0', 'snapshot.json')
  const raw = JSON.parse(readFileSync(file))
  raw.entries[0].text = 'damaged'
  writeFileSync(file, JSON.stringify(raw))
  assert.throws(() => store.read(context), { code: 'IMAGE_OUTBOX_CORRUPT' })
})
test('bounded entries snapshot images and asset validation', () => {
  const store = create(options(scratch()))
  assert.throws(() => save(store, Array.from({ length: LIMITS.entries + 1 }, () => entry())), { code: 'IMAGE_OUTBOX_COUNT' })
  assert.throws(() => save(store, [entry({ text: 'x'.repeat(LIMITS.snapshotBytes + 1) })]), { code: 'IMAGE_OUTBOX_SIZE' })
  const ref = { version: 1, id: randomUUID(), slot: 0, manifestHash: 'a'.repeat(64), imageCount: 5 }
  assert.throws(() => save(store, [entry({ imageReceipts: [ref, ref] })]), { code: 'IMAGE_OUTBOX_ENTRY' })
  assert.throws(() => save(store, [entry({ imageReceipts: [ref] })]), { code: 'IMAGE_OUTBOX_ASSET_REFUSED' })
  assert.throws(() => save(store, [entry({ imageReceipts: [{ ...ref, path: 'ignored', imageCount: 0 }] })]), { code: 'IMAGE_OUTBOX_RECEIPT' })
})
test('revision storage budget refuses without overwriting accepted data', () => {
  const root = scratch(); const store = create(options(root))
  let result = save(store, [])
  // Bounded fixture of authentic format avoids quadratic setup writes; public
  // read/write still exercise the actual on-disk capacity behavior.
  const first = JSON.parse(readFileSync(join(root, '0', 'snapshot.json')))
  let previous = result.generation
  for (let i = 1; i < LIMITS.revisions; i++) {
    const { checksum, ...record } = first
    Object.assign(record, { index: i, generation: randomUUID(), operationId: randomUUID(), previous })
    previous = record.generation
    const dir = join(root, String(i)); mkdirSync(dir)
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ ...record,
      checksum: createHash('sha256').update(JSON.stringify(record)).digest('hex') }))
  }
  result = store.read(context)
  assert.throws(() => save(store, [], result.generation), { code: 'IMAGE_OUTBOX_FULL' })
  assert.deepEqual(store.read(context), result)
})
test('hand journey: busy image-only plus text-image queue, restart, explicit candidate preparation', () => {
  const byteRoot = scratch(); const root = scratch()
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const custody = createDurableImageCustody({ root: byteRoot, authenticate, authorizeCandidate: () => true })
  const receipt = custody.retain({ operationId: randomUUID(), conversationId: 'conversation-a', accountId: 'account-a', provider: 'codex',
    images: [{ mime: 'image/gif', bytes }, { mime: 'image/gif', bytes }] }, context)
  const ref = { version: receipt.version, id: receipt.id, slot: receipt.slot, manifestHash: receipt.manifestHash, imageCount: 2 }
  const store = create({ ...options(root), validateReceipt: (r, { context, conversationId }) => {
    const held = custody.reopen(r, context)
    return held.conversationId === conversationId ? held.images.length : -1
  } })
  const queued = [entry({ text: '', imageReceipts: [ref] }), entry({ text: 'Describe these in order', imageReceipts: [ref] })]
  const saved = save(store, queued)
  const child = spawnSync(process.execPath, ['-e', `
    const {createImageOutbox}=require(process.argv[1]);
    const store=createImageOutbox({root:process.argv[2],conversationId:'conversation-a',authenticate:()=>({authenticated:true,productOwnerId:'owner-a'}),validateReceipt:()=>2});
    process.stdout.write(JSON.stringify(store.read({})));
  `, modulePath, root], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), saved)
  assert.equal(saved.automaticSend, false)
  const pending = save(store, [{ ...queued[0], state: 'unknown' }, queued[1]], saved.generation)
  const prepared = custody.reissue(ref, { conversationId: 'conversation-a', accountId: 'account-a', provider: 'codex',
    productOwnerId: 'owner-a', sessionId: 'new-session' }, context)
  assert.deepEqual(prepared.images.map(i => readFileSync(i.path)), [bytes, bytes])
  const accepted = save(store, [{ ...queued[0], state: 'accepted' }, queued[1]], pending.generation)
  assert.equal(store.read(context).entries[0].state, 'accepted')
  assert.ok(!JSON.stringify(accepted).includes(bytes.toString('base64')))
  assert.ok(!JSON.stringify(accepted).includes(byteRoot))
})

test('concurrent OS processes reserve one CAS generation and preserve winner', async () => {
  const root = scratch()
  const program = `
    const {createImageOutbox}=require(process.argv[1]);
    const {randomUUID}=require('node:crypto');
    const store=createImageOutbox({root:process.argv[2],conversationId:'conversation-a',
      authenticate:()=>({authenticated:true,productOwnerId:'owner-a'}),validateReceipt:()=>1});
    process.stdout.write('ready\\n');
    process.stdin.once('data',()=>{
      try { const result=store.write({expectedGeneration:null,operationId:randomUUID(),
        entries:[{envelopeId:randomUUID(),text:process.argv[3],imageReceipts:[],state:'not-sent'}]},{});
        process.stdout.write(JSON.stringify({ok:true,result})+'\\n');
      } catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code})+'\\n'); }
      process.stdin.destroy();
    });
  `
  const children = ['first writer','second writer'].map(text => {
    const child = spawn(process.execPath, ['-e', program, modulePath, root, text], { windowsHide: true, stdio: ['pipe','pipe','pipe'] })
    let output = ''; let error = ''; let ready
    const readyPromise = new Promise(resolve => { ready = resolve })
    child.stdout.on('data', data => { output += data; if (output.includes('ready\n')) ready() })
    child.stderr.on('data', data => { error += data })
    const done = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', code => {
        if (code !== 0) reject(new Error(error || 'child exit ' + code))
        else resolve(JSON.parse(output.trim().split('\n').at(-1)))
      })
    })
    return { child, readyPromise, done }
  })
  await Promise.all(children.map(c => c.readyPromise))
  children.forEach(c => c.child.stdin.end('go'))
  const results = await Promise.all(children.map(c => c.done))
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.ok(['IMAGE_OUTBOX_STALE','IMAGE_OUTBOX_INCOMPLETE'].includes(results.find(r => !r.ok).code))
  assert.deepEqual(create(options(root)).read(context), results.find(r => r.ok).result)
})

test('explicit cancel retirement destination transfer and ordinary omission gates', () => {
  const root = scratch()
  const store = create({ ...options(root), destinationSessionId: 'source', authorizeTransfer: ({ sourceSessionId, destinationSessionId }) => sourceSessionId === 'source' && destinationSessionId === 'empty-successor' })
  let result = store.admit({ expectedGeneration: null, operationId: randomUUID(), text: 'draft', imageReceipts: [] }, context)
  const draft = result.entries[0]
  assert.throws(() => save(store, [], result.generation), { code: 'IMAGE_OUTBOX_OMISSION_REFUSED' })
  assert.throws(() => store.retireAccepted({ expectedGeneration: result.generation, operationId: randomUUID(), envelopeIds: [draft.envelopeId] }, context), { code: 'IMAGE_OUTBOX_RETIRE_REFUSED' })
  assert.throws(() => store.transfer({ expectedGeneration: result.generation, operationId: randomUUID(), expectedDestinationSessionId: 'wrong', destinationSessionId: 'empty-successor' }, context), { code: 'IMAGE_OUTBOX_DESTINATION_STALE' })
  assert.throws(() => store.transfer({ expectedGeneration: result.generation, operationId: randomUUID(), expectedDestinationSessionId: 'source', destinationSessionId: 'occupied' }, context), { code: 'IMAGE_OUTBOX_TRANSFER_REFUSED' })
  assert.throws(() => store.transfer({ expectedGeneration: result.generation, operationId: randomUUID(), expectedDestinationSessionId: 'source', destinationSessionId: '' }, context), { code: 'IMAGE_OUTBOX_DESTINATION' })
  result = store.transfer({ expectedGeneration: result.generation, operationId: randomUUID(), expectedDestinationSessionId: 'source', destinationSessionId: 'empty-successor' }, context)
  assert.equal(create(options(root)).read(context).destinationSessionId, 'empty-successor')
  assert.deepEqual(result.entries, [draft])
  result = store.cancel({ expectedGeneration: result.generation, operationId: randomUUID(), envelopeIds: [draft.envelopeId] }, context)
  assert.equal(result.entries[0].state, 'cancelled')
  assert.throws(() => save(store, [draft], result.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  result = store.retireAccepted({ expectedGeneration: result.generation, operationId: randomUUID(), envelopeIds: [draft.envelopeId] }, context)
  assert.equal(result.entries.length, 0)
})
test('configuration malformed requests and sparse arrays name refusals', () => {
  assert.throws(() => create({}), { code: 'IMAGE_OUTBOX_CONFIGURATION' })
  const store = create(options(scratch()))
  assert.throws(() => store.write({}, context), { code: 'IMAGE_OUTBOX_REQUEST' })
  assert.throws(() => save(store, Array(1)), { code: 'IMAGE_OUTBOX_ENTRY' })
  assert.throws(() => save(store, [entry({ imageReceipts: Array(1) })]), { code: 'IMAGE_OUTBOX_RECEIPT' })
})

test('beginDelivery grants dispatch once; only trusted matching no-dispatch proof rearms', () => {
  const root = scratch(); const proofs = new Set()
  const opts = { ...options(root), authorizeNoDispatch: ({ attemptId }) => proofs.has(attemptId) }
  const store = create(opts)
  let snapshot = store.admit({ expectedGeneration: null, operationId: randomUUID(), text: 'queued while busy', imageReceipts: [] }, context)
  const envelopeId = snapshot.entries[0].envelopeId
  const begin = { expectedGeneration: snapshot.generation, operationId: randomUUID(), envelopeId }
  const started = store.beginDelivery(begin, context)
  assert.equal(started.entries[0].state, 'unknown')
  assert.equal(started.delivery.dispatchAllowed, true)
  assert.equal(create(opts).beginDelivery(begin, context).delivery.dispatchAllowed, false)
  assert.equal(store.read(context).delivery, undefined)
  const resolve = { expectedGeneration: started.generation, operationId: randomUUID(), envelopeId, attemptId: started.delivery.attemptId }
  assert.throws(() => store.resolveNoDispatch(resolve, context), { code: 'IMAGE_OUTBOX_NO_DISPATCH_REFUSED' })
  assert.throws(() => store.resolveNoDispatch({ ...resolve, attemptId: randomUUID() }, context), { code: 'IMAGE_OUTBOX_DELIVERY_REFUSED' })
  assert.throws(() => store.beginDelivery({ expectedGeneration: started.generation, operationId: randomUUID(), envelopeId }, context), { code: 'IMAGE_OUTBOX_DELIVERY_REFUSED' })
  assert.throws(() => save(store, [{ ...started.entries[0], state: 'not-sent' }], started.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  proofs.add(started.delivery.attemptId)
  snapshot = store.resolveNoDispatch(resolve, context)
  assert.equal(snapshot.entries[0].state, 'not-sent')
  const second = store.beginDelivery({ expectedGeneration: snapshot.generation, operationId: randomUUID(), envelopeId }, context)
  assert.notEqual(second.delivery.attemptId, started.delivery.attemptId)
  assert.throws(() => store.resolveNoDispatch({ ...resolve, expectedGeneration: second.generation, operationId: randomUUID() }, context), { code: 'IMAGE_OUTBOX_DELIVERY_REFUSED' })
  assert.equal(store.read(context).entries[0].state, 'unknown')
})

test('queued model and effort selection survive reopen and cannot drift under same envelope', () => {
  const root = scratch(); const store = create(options(root))
  const request = { expectedGeneration: null, operationId: randomUUID(), text: 'chosen settings', imageReceipts: [],
    selection: { model: 'chosen-model', effort: 'high' } }
  const saved = store.admit(request, context)
  assert.deepEqual(create(options(root)).read(context).entries[0].selection, request.selection)
  assert.deepEqual(store.admit(request, context), saved)
  assert.throws(() => store.admit({ ...request, selection: { model: 'other-model', effort: 'high' } }, context), { code: 'IMAGE_OUTBOX_IDEMPOTENCY_CONFLICT' })
  for (const selection of [{ model: 'other-model', effort: 'high' }, { model: 'chosen-model', effort: 'low' }, undefined])
    assert.throws(() => save(store, [{ ...saved.entries[0], selection }], saved.generation), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  for (const selection of [null, {}, { model: '', effort: null }, { model: 'x'.repeat(257), effort: null }])
    assert.throws(() => store.admit({ ...request, expectedGeneration: saved.generation, operationId: randomUUID(), selection }, context), { code: 'IMAGE_OUTBOX_SELECTION' })
})
