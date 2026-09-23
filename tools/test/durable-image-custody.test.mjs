import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, realpathSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const modulePath = resolve(process.env.IMAGE_CUSTODY_MODULE || fileURLToPath(new URL('../../shell/durable-image-custody.cjs', import.meta.url)))
const { createDurableImageCustody: create, LIMITS } = require(modulePath)
assert.ok(process.env.IMAGE_TEST_TEMP, 'IMAGE_TEST_TEMP must be an explicit fenced test directory')
const temp = realpathSync(process.env.IMAGE_TEST_TEMP)
const scratch = () => mkdtempSync(join(temp, 'image-retention-current-'))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const context = { productOwnerId: 'owner-a', epoch: 1 }
const authenticate = c => ({ authenticated: c?.epoch === 1, productOwnerId: c?.productOwnerId })
const request = () => ({ operationId: randomUUID(), conversationId: 'conversation-a', accountId: 'account-a', provider: 'codex', images: [{ mime: 'image/png', bytes: png }, { mime: 'image/gif', bytes: gif }] })
const candidate = overrides => ({ conversationId: 'conversation-a', accountId: 'account-a', provider: 'codex', productOwnerId: 'owner-a', sessionId: 'candidate-a', ...overrides })
const options = root => ({ root, authenticate, authorizeCandidate: () => true, engineImageBytes: 3000000 })
function fixture(extra = {}) { const root = scratch(); const store = create({ ...options(root), ...extra }); return { root, store, receipt: store.retain(request(), context) } }
test('owner, authentication and current epoch gate actual reads', () => {
  const { store, receipt } = fixture()
  assert.throws(() => store.reopen(receipt, { ...context, productOwnerId: 'owner-b' }), { code: 'IMAGE_CUSTODY_OWNER' })
  assert.throws(() => store.reopen(receipt, { ...context, epoch: 0 }), { code: 'IMAGE_CUSTODY_AUTH_REQUIRED' })
  assert.throws(() => store.retain(request(), null), { code: 'IMAGE_CUSTODY_AUTH_REQUIRED' })
})
test('real image bytes reopen ordered in a fresh OS process without sending', () => {
  const { root, store, receipt } = fixture()
  assert.equal(store.reopen(receipt, context).automaticSend, false)
  const child = spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs'); const {createDurableImageCustody:create}=require(process.argv[1]);
    const receipt=JSON.parse(process.argv[3]);
    const store=create({root:process.argv[2],authenticate:()=>({authenticated:true,productOwnerId:'owner-a'}),authorizeCandidate:()=>true});
    const r=store.reissue(receipt,{conversationId:'conversation-a',accountId:'account-a',provider:'codex',productOwnerId:'owner-a',sessionId:'new-process'},{});
    process.stdout.write(JSON.stringify({automaticSend:r.automaticSend,bytes:r.images.map(i=>fs.readFileSync(i.path).toString('hex'))}));
  `, modulePath, root, JSON.stringify(receipt)], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { automaticSend: false, bytes: [png.toString('hex'), gif.toString('hex')] })
  assert.ok(!JSON.stringify(receipt).includes(png.toString('base64')))
  assert.ok(!JSON.stringify(receipt).includes(root))
})
test('candidate reissue gates owner conversation session and allowed account/provider switch', () => {
  const { root, store, receipt } = fixture()
  for (const change of [{ productOwnerId: 'owner-b' }, { conversationId: 'conversation-b' }, { sessionId: '' }])
    assert.throws(() => store.reissue(receipt, candidate(change), context), { code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED' })
  const denied = create({ ...options(root), authorizeCandidate: () => false })
  assert.throws(() => denied.reissue(receipt, candidate({ accountId: 'account-b' }), context), { code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED' })
  const allowed = store.reissue(receipt, candidate({ accountId: 'account-b', provider: 'claude' }), context)
  assert.deepEqual(allowed.images.map(i => readFileSync(i.path)), [png, gif])
})
test('candidate provider support and measured delivery limits fail closed', () => {
  const { root, store, receipt } = fixture()
  for (const provider of ['gemini','grok','local','unknown'])
    assert.throws(() => store.reissue(receipt, candidate({ provider }), context), { code: 'IMAGE_CUSTODY_PROVIDER_UNSUPPORTED' })
  const unknown = create({ ...options(root), engineImageBytes: undefined })
  assert.throws(() => unknown.reissue(receipt, candidate({ provider: 'claude' }), context), { code: 'IMAGE_CUSTODY_PROVIDER_LIMIT_UNKNOWN' })
  const small = create({ ...options(root), engineImageBytes: 1 })
  assert.throws(() => small.reissue(receipt, candidate({ provider: 'claude' }), context), { code: 'IMAGE_CUSTODY_PROVIDER_SIZE' })
  assert.equal(small.reissue(receipt, candidate(), context).images.length, 2)
})
test('corrupted bytes and manifest fail integrity without issuing a path', () => {
  const { root, store, receipt } = fixture()
  const image = join(root, String(receipt.slot), receipt.id + '-0.png')
  const damaged = Buffer.from(png); damaged[damaged.length - 1] ^= 1
  writeFileSync(image, damaged)
  assert.throws(() => store.reissue(receipt, candidate(), context), { code: 'IMAGE_CUSTODY_CORRUPT' })
  writeFileSync(image, png)
  const manifest = join(root, String(receipt.slot), 'manifest.json')
  writeFileSync(manifest, '{}')
  assert.throws(() => store.reopen(receipt, context), { code: 'IMAGE_CUSTODY_CORRUPT' })
})
test('count byte signature receipt expiry and disk reservation bounds', () => {
  const root = scratch(); const store = create(options(root))
  const r = request()
  assert.throws(() => store.retain({ ...r, images: Array(9).fill(r.images[0]) }, context), { code: 'IMAGE_CUSTODY_COUNT' })
  assert.throws(() => store.retain({ ...r, images: [{ mime: 'image/png', bytes: Buffer.alloc(LIMITS.imageBytes + 1) }] }, context), { code: 'IMAGE_CUSTODY_SIZE' })
  const big = Buffer.alloc(LIMITS.imageBytes); png.copy(big)
  assert.throws(() => store.retain({ ...r, images: Array(3).fill({ mime: 'image/png', bytes: big }) }, context), { code: 'IMAGE_CUSTODY_SIZE' })
  assert.throws(() => store.retain({ ...r, images: [{ mime: 'image/png', bytes: gif }] }, context), { code: 'IMAGE_CUSTODY_FORMAT' })
  assert.equal(readdirSync(root).length, 0)
  const receipt = store.retain(r, context)
  assert.throws(() => store.reopen({ ...receipt, slot: -1 }, context), { code: 'IMAGE_CUSTODY_RECEIPT' })
  const late = create({ ...options(root), now: () => Date.now() + LIMITS.ageMs + 1 })
  assert.throws(() => late.reopen(receipt, context), { code: 'IMAGE_CUSTODY_EXPIRED' })
  for (let i = 1; i < LIMITS.records; i++) store.retain(request(), context)
  assert.throws(() => store.retain(request(), context), { code: 'IMAGE_CUSTODY_FULL' })
  assert.equal(store.reopen(receipt, context).images.length, 2)
})

test('required configuration scope operation and lost-receipt idempotency', () => {
  assert.throws(() => create({ root: '' }), { code: 'IMAGE_CUSTODY_CONFIGURATION' })
  const root = scratch(); const store = create(options(root)); const r = request()
  assert.throws(() => store.retain({ ...r, conversationId: '' }, context), { code: 'IMAGE_CUSTODY_SCOPE' })
  assert.throws(() => store.retain({ ...r, operationId: undefined }, context), { code: 'IMAGE_CUSTODY_OPERATION' })
  const receipt = store.retain(r, context)
  assert.deepEqual(create(options(root)).retain(r, context), receipt)
  assert.equal(readdirSync(root).length, 1)
  assert.throws(() => store.retain({ ...r, accountId: 'different-account' }, context), { code: 'IMAGE_CUSTODY_IDEMPOTENCY_CONFLICT' })
  assert.throws(() => store.retain({ ...r, images: [...r.images].reverse() }, context), { code: 'IMAGE_CUSTODY_IDEMPOTENCY_CONFLICT' })
  mkdirSync(join(root, '1'))
  assert.throws(() => store.retain(request(), context), { code: 'IMAGE_CUSTODY_INCOMPLETE' })
})
test('non-directory root and file identity changes refuse rather than read outside authority', () => {
  const root = scratch(); const file = join(root, 'file'); writeFileSync(file, 'ordinary file')
  assert.throws(() => create(options(file)), { code: 'IMAGE_CUSTODY_PATH_REFUSED' })
  const { store, receipt } = fixture()
  const fs = require('node:fs'); const original = fs.fstatSync
  fs.fstatSync = fd => { const stat = original(fd); stat.size++; return stat }
  try { assert.throws(() => store.reopen(receipt, context), { code: 'IMAGE_CUSTODY_CHANGED' }) }
  finally { fs.fstatSync = original }
})
test('sparse image input refuses with a named error before any reservation', () => {
  const root = scratch(); const store = create(options(root))
  assert.throws(() => store.retain({ ...request(), images: Array(1) }, context), { code: 'IMAGE_CUSTODY_FORMAT' })
  assert.equal(readdirSync(root).length, 0)
})

test('reusing a reservation never reuses an old issued image path', () => {
  const { root, store, receipt } = fixture()
  const original = store.reissue(receipt, candidate(), context)
  // Preserve all bytes: move the synthetic old reservation aside, then reuse its
  // slot. This exercises stale capability behavior without executing deletion.
  require('node:fs').renameSync(join(root, String(receipt.slot)), join(root, 'preserved-original'))
  const next = store.retain(request(), context)
  assert.equal(next.slot, receipt.slot)
  const issued = store.reissue(next, candidate(), context)
  assert.notEqual(issued.images[0].path, original.images[0].path)
  assert.deepEqual(issued.images.map(i => readFileSync(i.path)), [png, gif])
  assert.throws(() => store.reopen(receipt, context), { code: 'IMAGE_CUSTODY_CORRUPT' })
  assert.throws(() => readFileSync(original.images[0].path), { code: 'ENOENT' })
})
