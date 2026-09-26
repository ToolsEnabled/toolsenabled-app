'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createDraftImageAuthority } = require('../../shell/draft-image-authority.cjs')
const REPICK = { code: 'IMAGE_CUSTODY_REPICK_REQUIRED' }
function fixture(kind = 'tree', limits = {}) {
  const context = {}, window = {}, draftIdentity = {}, incarnation = {}
  const owner = { productOwnerId: 'fixture-owner', currentEpoch: 1, window }
  const draft = { ...owner, kind, identity: draftIdentity, incarnation, live: true,
    ...(kind === 'tree' ? { computerId: 'computer', treeId: 'tree', nodeId: 'node' }
      : { expectedSessionId: 'fresh-session', expectedTranscript: { computerId: 'computer', nodeId: 'standalone-record' } }) }
  const destination = { ...owner, session: {}, sessionId: 'fresh-session', live: true,
    provider: 'codex', accountId: 'chosen-account', issued: new Set(),
    draftIdentity, draftIncarnation: incarnation, treeId: 'tree',
    transcript: { computerId: 'computer', nodeId: kind === 'tree' ? 'node' : 'standalone-record' } }
  let serial = 0, destinationHook = null
  const api = createDraftImageAuthority({
    authenticate: value => { if (value !== context) throw new Error('wrong context'); return { ...owner } },
    readDraft: id => id === draftIdentity ? draft : null,
    readDestination: id => { destinationHook?.(); return id === destination.sessionId ? destination : null },
    mintId: () => 'grant-' + (++serial), ...limits
  })
  const capture = () => api.capture(draftIdentity, context)
  const grant = capture()
  return { api, grant, capture, owner, draft, destination, context,
    hook: fn => { destinationHook = fn },
    add: (file = '/inert/generated-one.png') => api.addSaved(grant, file, context),
    adopt: paths => api.adopt(grant, { sessionId: destination.sessionId, paths }, context) }
}
test('saved ordered paths adopt into exact live destination, same-session retry is idempotent', () => {
  const h = fixture()
  h.add('/inert/one.png'); h.add('/inert/two.png')
  const result = h.adopt(['/inert/two.png', '/inert/one.png'])
  assert.deepEqual(result.paths, ['/inert/two.png', '/inert/one.png'])
  assert.deepEqual([...h.destination.issued], result.paths)
  assert.equal(result.provider, 'codex'); assert.equal(result.accountId, 'chosen-account')
  assert.equal(result.automaticSend, false)
  assert.deepEqual(h.adopt(result.paths), result)
  assert.equal(h.destination.issued.size, 2)
  assert.throws(() => h.add('/inert/later.png'), REPICK)
})
test('owner A to B to A epoch change during save invalidates captured authority', () => {
  const h = fixture()
  h.owner.productOwnerId = 'other'; h.owner.currentEpoch = 2
  h.owner.productOwnerId = 'fixture-owner'; h.owner.currentEpoch = 3
  assert.throws(() => h.add(), REPICK)
  assert.equal(h.destination.issued.size, 0)
})
for (const change of ['window', 'incarnation', 'retired']) test('captured draft refuses changed ' + change, () => {
  const h = fixture(); h.add()
  if (change === 'window') h.owner.window = {}
  if (change === 'incarnation') h.draft.incarnation = {}
  if (change === 'retired') h.draft.live = false
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  assert.equal(h.destination.issued.size, 0)
})
test('legacy lookalike grant cannot acquire provenance', () => {
  const h = fixture()
  assert.throws(() => h.api.addSaved({ ...h.grant }, '/inert/legacy.png', h.context), REPICK)
  assert.throws(() => h.api.capture('renderer-hold-key', h.context), REPICK)
})
for (const field of ['node', 'tree', 'provider', 'account', 'owner', 'retired', 'switch']) {
  test('destination ' + field + ' mismatch grants no path', () => {
    const h = fixture(); h.add()
    if (field === 'node') h.destination.transcript.nodeId = 'other'
    if (field === 'tree') h.destination.treeId = 'other'
    if (field === 'provider') h.destination.provider = ''
    if (field === 'account') h.destination.accountId = ''
    if (field === 'owner') h.destination.productOwnerId = 'other'
    if (field === 'retired') h.destination.retired = true
    if (field === 'switch') h.destination.switchPending = true
    assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
    assert.equal(h.destination.issued.size, 0)
  })
}
test('binding absent keeps paths available for same destination after binding repair', () => {
  const h = fixture(); h.add()
  const transcript = h.destination.transcript
  h.destination.transcript = null
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  assert.equal(h.destination.issued.size, 0)
  h.destination.transcript = transcript
  assert.equal(h.adopt(['/inert/generated-one.png']).sessionId, 'fresh-session')
})
test('unknown, duplicate, sparse batch validation precedes all capability writes', () => {
  const h = fixture(); h.add()
  for (const paths of [['/inert/generated-one.png', '/inert/unknown.png'],
    ['/inert/generated-one.png', '/inert/generated-one.png'], Array(1)]) {
    assert.throws(() => h.adopt(paths), REPICK)
    assert.equal(h.destination.issued.size, 0)
  }
  assert.equal(h.adopt(['/inert/generated-one.png']).paths.length, 1)
})
test('already adopted grant cannot bless replacement object or changed account', () => {
  const h = fixture(); h.add(); h.adopt(['/inert/generated-one.png'])
  const original = h.destination.session
  h.destination.session = {}
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  h.destination.session = original
  h.destination.accountId = 'other-account'
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
})
test('destination replacement during final validation grants neither Set', () => {
  const h = fixture(); h.add()
  const firstSet = h.destination.issued
  let reads = 0
  h.hook(() => { if (++reads === 2) { h.destination.session = {}; h.destination.issued = new Set() } })
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  assert.equal(firstSet.size, 0); assert.equal(h.destination.issued.size, 0)
})
test('standalone uses host draft association and actual transcript tuple without synthetic tree', () => {
  const h = fixture('standalone'); h.add()
  delete h.destination.treeId
  assert.equal(h.adopt(['/inert/generated-one.png']).sessionId, 'fresh-session')
  const other = fixture('standalone'); other.add()
  other.destination.sessionId = 'unexpected-session'
  assert.throws(() => other.adopt(['/inert/generated-one.png']), REPICK)
  other.destination.sessionId = 'fresh-session'
  other.destination.transcript.nodeId = 'other-record'
  assert.throws(() => other.adopt(['/inert/generated-one.png']), REPICK)
})
test('explicit configured grant/path bounds refuse rather than silently dropping entries', () => {
  const h = fixture('tree', { maxGrants: 1, maxPaths: 1 })
  assert.throws(() => h.capture(), REPICK)
  h.add()
  assert.throws(() => h.add('/inert/second.png'), REPICK)
  assert.throws(() => h.add(), REPICK)
  assert.equal(h.adopt(['/inert/generated-one.png']).paths.length, 1)
})

test('explicit revocation reuses bounded quota while unrelated live grant remains valid', () => {
  const h = fixture('tree', { maxGrants: 2 })
  h.add()
  const stale = []
  for (let i = 0; i < 12; i++) {
    const grant = h.capture()
    h.api.addSaved(grant, '/inert/cycle-' + i + '.png', h.context)
    h.api.revoke(grant, h.context)
    assert.deepEqual(h.api.revoke(grant, h.context), { revoked: true })
    stale.push(grant)
  }
  for (const grant of stale) {
    assert.throws(() => h.api.assert(grant, h.context), REPICK)
    assert.throws(() => h.api.addSaved(grant, '/inert/stale.png', h.context), REPICK)
    assert.throws(() => h.api.adopt(grant, { sessionId: 'fresh-session', paths: ['/inert/stale.png'] }, h.context), REPICK)
  }
  assert.equal(h.adopt(['/inert/generated-one.png']).paths.length, 1)
  h.api.revoke(h.grant, h.context)
  assert.deepEqual([...h.destination.issued], ['/inert/generated-one.png'], 'revocation does not revoke issued session paths')
  assert.throws(() => h.api.revoke(stale[0], {}), REPICK)
})
test('owner changes inside final destination callback refuse before Set mutation', () => {
  const h = fixture(); h.add()
  let reads = 0
  h.hook(() => { if (++reads === 2) h.owner.currentEpoch = 2 })
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  assert.equal(h.destination.issued.size, 0)
})

test('host invalidation permits epoch/window turnover beyond quota and permanently rejects prior handles', () => {
  const h = fixture('tree', { maxGrants: 1 })
  const stale = [h.grant]
  h.add(); h.adopt(['/inert/generated-one.png'])
  for (let i = 0; i < 12; i++) {
    h.owner.currentEpoch += 1; h.owner.window = {}
    Object.assign(h.draft, h.owner); Object.assign(h.destination, h.owner)
    h.api.invalidateAll()
    const grant = h.capture()
    h.api.addSaved(grant, '/inert/turnover-' + i + '.png', h.context)
    for (const old of stale) {
      assert.throws(() => h.api.assert(old, h.context), REPICK)
      assert.throws(() => h.api.addSaved(old, '/inert/stale.png', h.context), REPICK)
      assert.throws(() => h.api.adopt(old, { sessionId: 'fresh-session', paths: ['/inert/stale.png'] }, h.context), REPICK)
      assert.throws(() => h.api.revoke(old, h.context), REPICK)
    }
    assert.throws(() => h.capture(), REPICK, 'stale revoke must never decrement current generation quota')
    stale.push(grant)
  }
  assert.deepEqual([...h.destination.issued], ['/inert/generated-one.png'])
  // Same-owner invalidation must also be permanent, not merely an auth mismatch.
  const old = stale.at(-1)
  h.api.invalidateAll()
  assert.throws(() => h.api.assert(old, h.context), REPICK)
  assert.ok(h.capture())
})
for (const change of ['incarnation', 'retirement']) test('final destination read cannot hide draft ' + change, () => {
  const h = fixture(); h.add()
  let reads = 0
  h.hook(() => {
    if (++reads !== 2) return
    if (change === 'incarnation') h.draft.incarnation = {}
    else h.draft.live = false
  })
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  assert.equal(h.destination.issued.size, 0)
})
test('final destination lifecycle invalidation never writes issued paths', () => {
  const h = fixture(); h.add()
  let reads = 0
  h.hook(() => { if (++reads === 2) h.api.invalidateAll() })
  assert.throws(() => h.adopt(['/inert/generated-one.png']), REPICK)
  assert.equal(h.destination.issued.size, 0)
  assert.ok(h.capture())
})
