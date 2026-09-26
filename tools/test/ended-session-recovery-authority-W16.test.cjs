'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createEndedSessionRecoveryAuthority } = require('../../shell/ended-session-recovery-authority.cjs')
function fixture(limits = {}) {
  const context = {}, owner = { window: {}, productOwnerId: 'owner', productPrincipal: 'principal', currentEpoch: 1 }
  const source = { ...owner, session: {}, sessionId: 'source', live: true,
    transcript: { computerId: 'computer', nodeId: 'real-node' }, provider: 'codex', accountId: 'source-account',
    threadId: 'source-thread', cwd: path.resolve(__dirname), issued: new Set() }
  let sourcePresent = true, next = 0, token = 0, destination = null, proof = false, destinationHook = null
  const api = createEndedSessionRecoveryAuthority({
    authenticate: value => { if (value !== context) throw new Error('owner'); return { ...owner } },
    readSource: id => sourcePresent && id === source.sessionId ? source : null,
    readDestination: id => { destinationHook?.(); return destination?.sessionId === id ? destination : null },
    mintId: () => 'opaque-' + (++token), mintSessionId: () => 'fresh-' + (++next),
    verifyNotStarted: () => proof,
    validateCustodyReceipt: receipt => receipt.validated === true,
    ...limits,
  })
  const capture = receipts => api.capture('source', { retainedReceipts: receipts || [] }, context)
  function install(reservation, transcript = null) {
    destination = { ...owner, session: {}, sessionId: reservation.sessionId, live: true,
      recoveryReservation: reservation, provider: 'claude', accountId: 'chosen-account', threadId: 'fresh-thread',
      transcript, issued: new Set() }
    return destination
  }
  return { api, owner, source, context, capture, install,
    retire: () => { source.live = false; sourcePresent = false },
    proof: value => { proof = value }, removeDestination: () => { destination = null },
    hook: fn => { destinationHook = fn },
  }
}
test('text-only capture survives source deletion and authorizes one explicit successor binding', () => {
  const h = fixture(), receipt = h.capture()
  h.retire()
  const inspected = h.api.inspect(receipt, h.context)
  assert.deepEqual(inspected.issuedPaths, []); assert.deepEqual(inspected.retainedReceipts, [])
  assert.equal(inspected.cwd, path.resolve(__dirname))
  assert.equal(inspected.sourceThreadId, 'source-thread')
  assert.equal(inspected.productPrincipal, 'principal')
  const reservation = h.api.reserve(receipt, h.context)
  assert.equal(h.api.reserve(receipt, h.context), reservation)
  const destination = h.install(reservation)
  assert.throws(() => h.api.claim(receipt, reservation, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
  const binding = h.api.authorizeBinding(receipt, reservation, h.context)
  assert.equal(binding.session, destination.session)
  assert.deepEqual(binding.transcript, { computerId: 'computer', nodeId: 'real-node' })
  destination.transcript = binding.transcript
  const claimed = h.api.claim(receipt, reservation, h.context)
  assert.equal(claimed.destination.session, destination.session)
  assert.equal(claimed.destination.accountId, 'chosen-account')
  assert.equal(claimed.automaticSend, false)
  assert.deepEqual(h.api.claim(receipt, reservation, h.context), claimed)
  assert.equal(destination.issued.size, 0)
})
test('capture refuses after source has retired instead of manufacturing a source', () => {
  const h = fixture(); h.retire()
  assert.throws(() => h.capture(), { code: 'RECOVERY_SOURCE_REQUIRED' })
})
test('captured issued membership is immutable evidence and never successor capability', () => {
  const h = fixture()
  h.source.issued.add('/inert/original.png')
  const receipt = h.capture()
  h.source.issued.clear(); h.source.issued.add('/inert/later-held.png')
  h.retire()
  const reservation = h.api.reserve(receipt, h.context)
  const destination = h.install(reservation, { computerId: 'computer', nodeId: 'real-node' })
  const claimed = h.api.claim(receipt, reservation, h.context)
  assert.deepEqual(claimed.issuedPaths, ['/inert/original.png'])
  assert.ok(Object.isFrozen(claimed.issuedPaths))
  assert.equal(destination.issued.size, 0)
})
test('only separately validated custody references are copied, malformed and sparse references refuse', () => {
  const h = fixture()
  const valid = { validated: true, version: 1, id: 'receipt', slot: 0, manifestHash: 'a'.repeat(64), imageCount: 1 }
  const receipt = h.capture([valid])
  valid.id = 'mutated'
  assert.equal(h.api.inspect(receipt, h.context).retainedReceipts[0].id, 'receipt')
  assert.throws(() => h.capture([{ ...valid, validated: false }]), { code: 'RECOVERY_RECEIPT_REFUSED' })
  assert.throws(() => h.capture(Array(1)), { code: 'RECOVERY_RECEIPT_REFUSED' })
})
for (const field of ['window', 'currentEpoch', 'productPrincipal']) test('captured recovery refuses changed ' + field, () => {
  const h = fixture(), receipt = h.capture()
  h.owner[field] = field === 'window' ? {} : field === 'currentEpoch' ? 3 : 'other-principal'
  assert.throws(() => h.api.inspect(receipt, h.context), { code: 'RECOVERY_OWNER_CHANGED' })
})
test('renderer copy of private reservation cannot authorize binding or claim', () => {
  const h = fixture(), receipt = h.capture(), reservation = h.api.reserve(receipt, h.context)
  h.install(reservation, { computerId: 'computer', nodeId: 'real-node' })
  assert.throws(() => h.api.authorizeBinding(receipt, { ...reservation }, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
  assert.throws(() => h.api.claim(receipt, { ...reservation }, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
})
test('wrong transcript, source object reuse and post-claim successor replacement refuse', () => {
  const h = fixture(), receipt = h.capture(), reservation = h.api.reserve(receipt, h.context)
  const dest = h.install(reservation, { computerId: 'computer', nodeId: 'wrong' })
  assert.throws(() => h.api.claim(receipt, reservation, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
  dest.transcript.nodeId = 'real-node'
  const pointer = dest.session
  dest.session = h.source.session
  assert.throws(() => h.api.claim(receipt, reservation, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
  dest.session = pointer
  h.api.claim(receipt, reservation, h.context)
  dest.session = {}
  assert.throws(() => h.api.claim(receipt, reservation, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
})
test('proven not-started release retries same minted ID with a new private ticket', () => {
  const h = fixture(), receipt = h.capture(), first = h.api.reserve(receipt, h.context)
  assert.throws(() => h.api.releaseNotStarted(receipt, first, h.context), { code: 'RECOVERY_RETRY_REFUSED' })
  h.proof(true)
  assert.equal(h.api.releaseNotStarted(receipt, first, h.context).sessionId, first.sessionId)
  const second = h.api.reserve(receipt, h.context)
  assert.equal(second.sessionId, first.sessionId); assert.notEqual(second, first)
  assert.throws(() => h.api.releaseNotStarted(receipt, first, h.context), { code: 'RECOVERY_RETRY_REFUSED' })
  const dest = h.install(second, { computerId: 'computer', nodeId: 'real-node' })
  assert.throws(() => h.api.claim(receipt, first, h.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
  assert.throws(() => h.api.releaseNotStarted(receipt, second, h.context), { code: 'RECOVERY_RETRY_REFUSED' })
  assert.equal(h.api.claim(receipt, second, h.context).destination.session, dest.session)
})
test('final destination read owner change refuses before association', () => {
  const h = fixture(), receipt = h.capture(), reservation = h.api.reserve(receipt, h.context)
  h.install(reservation, { computerId: 'computer', nodeId: 'real-node' })
  let calls = 0
  h.hook(() => { if (++calls === 2) h.owner.currentEpoch = 2 })
  assert.throws(() => h.api.claim(receipt, reservation, h.context), { code: 'RECOVERY_OWNER_CHANGED' })
})
test('bounded records recover through lifecycle invalidation and old recovery IDs never revive', () => {
  const h = fixture({ maxRecords: 1, mintId: () => 'same-base' })
  const stale = []
  for (let i = 0; i < 12; i++) {
    const receipt = h.capture(); stale.push(receipt)
    assert.throws(() => h.capture(), { code: 'RECOVERY_LIMIT' })
    h.api.invalidateAll()
    for (const old of stale) assert.throws(() => h.api.inspect(old, h.context), { code: 'RECOVERY_STALE' })
    h.owner.currentEpoch += 1; h.owner.window = {}
    Object.assign(h.source, h.owner)
  }
  const fresh = h.capture()
  assert.equal(new Set([...stale, fresh].map(row => row.recoveryId)).size, 13)
  h.api.revoke(fresh, h.context)
  assert.throws(() => h.api.inspect(fresh, h.context), { code: 'RECOVERY_STALE' })
  assert.ok(h.capture())
})

test('revoked recovery cannot reuse a successor session ID even with constant mint input', () => {
  const h = fixture({ mintSessionId: () => 'constant-id' })
  const firstReceipt = h.capture()
  const first = h.api.reserve(firstReceipt, h.context)
  h.api.revoke(firstReceipt, h.context)
  const secondReceipt = h.capture()
  const second = h.api.reserve(secondReceipt, h.context)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.ok(second.sessionId.length <= 128)
  assert.match(second.sessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  h.proof(true)
  h.api.releaseNotStarted(secondReceipt, second, h.context)
  assert.equal(h.api.reserve(secondReceipt, h.context).sessionId, second.sessionId)
  assert.throws(() => h.api.reserve(firstReceipt, h.context), { code: 'RECOVERY_STALE' })
})
test('separate managers namespace constant successor mint input independently', () => {
  const a = fixture({ mintSessionId: () => 'constant-id' })
  const b = fixture({ mintSessionId: () => 'constant-id' })
  assert.notEqual(a.api.reserve(a.capture(), a.context).sessionId, b.api.reserve(b.capture(), b.context).sessionId)
})
test('non-normalized cwd and overlong minted successor input refuse without filesystem access', () => {
  const h = fixture()
  h.source.cwd = path.resolve(__dirname) + path.sep + '..' + path.sep + path.basename(__dirname)
  assert.throws(() => h.capture(), { code: 'RECOVERY_SOURCE_REQUIRED' })
  const long = fixture({ mintSessionId: () => 'x'.repeat(129) })
  const receipt = long.capture()
  assert.throws(() => long.api.reserve(receipt, long.context), { code: 'RECOVERY_DESTINATION_REFUSED' })
})
test('configured accumulated-path bound copies the entire Set and refuses overflow without truncation', () => {
  const h = fixture({ maxPaths: 16 })
  for (let i = 0; i < 16; i++) h.source.issued.add('/inert/accumulated-' + i + '.png')
  const receipt = h.capture()
  assert.deepEqual(h.api.inspect(receipt, h.context).issuedPaths, [...h.source.issued])
  h.source.issued.add('/inert/overflow.png')
  assert.throws(() => h.capture(), { code: 'RECOVERY_LIMIT' })
  assert.equal(h.api.inspect(receipt, h.context).issuedPaths.length, 16)
})
