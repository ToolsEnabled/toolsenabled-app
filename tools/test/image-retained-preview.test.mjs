import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
const app = process.env.IMAGE_APP_ROOT || path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(app, 'package.json'))
const { createImageRetentionService } = require(path.join(app, 'shell/image-retention-service.cjs'))
const { createDurableImageCustody, LIMITS } = require(path.join(app, 'shell/durable-image-custody.cjs'))
const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const temp = process.env.IMAGE_TEST_TEMP || tmpdir()
function treeBytes(root) {
  const result = {}
  const walk = (dir) => { for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) walk(file)
    else result[path.relative(root, file)] = readFileSync(file).toString('base64')
  } }
  walk(root); return result
}
function fixture() {
  const root = mkdtempSync(path.join(temp, 'retained-preview-'))
  console.log('RETAINED_FIXTURE ' + root)
  const image = path.join(root, 'synthetic.gif'); writeFileSync(image, bytes)
  const context = { authenticated: true, productOwnerId: 'fixture-owner' }
  let candidateReads = 0
  const service = createImageRetentionService({ root: path.join(root, 'custody'),
    authenticate: value => { if (value !== context) throw Object.assign(new Error('wrong owner'), { code: 'IMAGE_CUSTODY_AUTH_REQUIRED' }); return context },
    sourceAuthority: () => ({ accountId: 'old-account', provider: 'codex', issued: new Set([image]) }),
    candidateAuthority: () => { candidateReads++; throw Object.assign(new Error('retired session'), { code: 'MC_AGENT_UNKNOWN_SESSION' }) },
    authorizeTransfer: () => true, engineImageBytes: 3000000 })
  const run = request => service.run({ conversationId: 'node-conversation', ...request }, context)
  const receipt = run({ operation: 'retain', operationId: randomUUID(), images: [{ path: image }] }).result
  const saved = run({ operation: 'admit', operationId: randomUUID(), expectedGeneration: null,
    text: 'Synthetic retained words', imageReceipts: [receipt] }).result
  const moved = run({ operation: 'transfer', operationId: randomUUID(), expectedGeneration: saved.generation,
    expectedDestinationSessionId: null, destinationSessionId: 'retired-session' }).result
  return { root, context, receipt, service, run, entry: moved.entries[0], candidateReads: () => candidateReads }
}

test('retained image preview survives reopen with a retired destination and changes no custody bytes', () => {
  const f = fixture(), before = treeBytes(f.root), saved = f.run({ operation: 'read' }).result
  const reply = f.run({ operation: 'preview', envelopeId: f.entry.envelopeId })
  assert.equal(reply.ok, true)
  assert.equal(reply.result.envelopeId, f.entry.envelopeId)
  assert.equal(reply.result.thumbnail, 'data:image/gif;base64,' + bytes.toString('base64'))
  assert.equal(reply.result.imageCount, 1)
  assert.equal(reply.result.automaticSend, false)
  assert.equal(f.candidateReads(), 0)
  assert.deepEqual(f.run({ operation: 'read' }).result, saved)
  assert.deepEqual(treeBytes(f.root), before)
  assert.equal(JSON.stringify(reply).includes(f.root), false)
})

test('preview refuses wrong owners, unknown envelopes and a different conversation', () => {
  const f = fixture()
  assert.throws(() => f.service.run({ operation: 'preview', conversationId: 'node-conversation', envelopeId: f.entry.envelopeId }, {}), { code: 'IMAGE_CUSTODY_AUTH_REQUIRED' })
  assert.throws(() => f.run({ operation: 'preview', envelopeId: randomUUID() }), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  assert.throws(() => f.run({ operation: 'preview', conversationId: 'different-conversation', envelopeId: f.entry.envelopeId }), { code: 'IMAGE_OUTBOX_ENVELOPE_CONFLICT' })
  assert.equal(f.candidateReads(), 0)
})

test('preview verifies retained image bytes before returning display data', () => {
  const f = fixture()
  const find = dir => { for (const name of readdirSync(dir)) { const file = path.join(dir, name)
    if (statSync(file).isDirectory()) { const found = find(file); if (found) return found }
    else if (name === f.receipt.id + '-0.gif') return file
  } }
  const image = find(f.root); assert.ok(image)
  writeFileSync(image, Buffer.alloc(bytes.length))
  assert.throws(() => f.run({ operation: 'preview', envelopeId: f.entry.envelopeId }), { code: 'IMAGE_CUSTODY_CORRUPT' })
})

test('delivery expiry preserves the thumbnail but still refuses provider reissue', () => {
  const root = mkdtempSync(path.join(temp, 'retained-preview-expired-'))
  console.log('RETAINED_FIXTURE ' + root)
  let clock = 1000
  const context = { authenticated: true, productOwnerId: 'fixture-owner' }
  const custody = createDurableImageCustody({ root, authenticate: () => context,
    authorizeCandidate: () => true, engineImageBytes: 3000000, now: () => clock })
  const receipt = custody.retain({ operationId: randomUUID(), conversationId: 'node',
    accountId: 'old-account', provider: 'codex', images: [{ mime: 'image/gif', bytes }] }, context)
  clock += LIMITS.ageMs + 1
  const before = treeBytes(root)
  assert.equal(custody.preview(receipt, context).thumbnail, 'data:image/gif;base64,' + bytes.toString('base64'))
  assert.throws(() => custody.reissue(receipt, { productOwnerId: context.productOwnerId, conversationId: 'node',
    accountId: 'new-account', provider: 'codex', sessionId: 'successor' }, context), { code: 'IMAGE_CUSTODY_EXPIRED' })
  assert.deepEqual(treeBytes(root), before)
})
