import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import facadeModule from '../../shell/agent-facade.cjs'
import surfaceModule from '../../shell/agent-command-surface.cjs'
import desktopModule from '../../shell/remote-desktop-sessions.cjs'

const CHUNK = 64 * 1024
const MAX = 65 * 1024 * 1024
const path = '/v1/agent/desktop-tree'
const digest = value => createHash('sha256').update(value).digest('hex')
const workspace = () => ({ ok: true, mayWrite: false, desktopTree: {
  version: 1, computerId: 'this-computer',
  trees: [{ id: 'tree-a', name: 'Existing desktop tree' }, { id: 'tree-b', name: 'Saved work' }],
  nodes: [
    { id: 'parent', treeId: 'tree-a', parentId: null, status: 'finished', message: 'Original task', reply: '完整 🌳 reply '.repeat(16000) },
    { id: 'child', treeId: 'tree-a', parentId: 'parent', status: 'running', sessionId: 'native-child' },
    { id: 'draft', treeId: 'tree-a', parentId: 'child', status: 'draft', message: 'Unstarted work' },
    { id: 'archived', treeId: 'tree-b', parentId: null, status: 'failed', message: 'Retained failure' },
  ],
}, sessions: [{ sessionId: 'native-child', nodeId: 'child', busy: false, turnsCompleted: 2, lastTurnStatus: 'success' }], sessionsTruncated: false })

async function fixture(t, answer = workspace()) {
  const calls = [], state = { answer, principal: { kind: 'relay', owner: {}, mayWrite: false },
    now: 0, generation: 1, deviceId: 'device-a', pairId: 'pair-a', leaseChecks: 0 }
  const surface = { commands: Object.keys(surfaceModule.COMMANDS), sessionLoad: () => ({ open: 1, max: 8 }),
    run: async (command, payload, principal) => {
      calls.push({ command, payload, principal })
      await state.beforeRead?.()
      return state.answer
    } }
  // Use the real native lease, including original pairing/epoch checks. The
  // large source fixture controls data size only, not cached-page authority.
  const native = desktopModule.createRemoteDesktopSessions({ sessions: new Map(),
    currentPrincipal: () => state.principal, connectionTicket: () => state.generation,
    connectionContinues: ticket => ticket === state.generation,
    deviceStatus: async () => ({ connected: true, deviceId: state.deviceId, pairId: state.pairId }),
  })
  const facade = facadeModule.createAgentFacade({ surface, principalForRelay: () => state.principal,
    desktopTreeSnapshotNow: () => state.now,
    desktopTreeReadLease: async principal => {
      const check = await native.treeReadLease(principal)
      return async current => {
        state.leaseChecks += 1
        await state.beforeCheck?.()
        return check(current)
      }
    }, log() {} })
  let { origin, token } = await facade.listen()
  t.after(() => facade.close())
  const call = async (query = '', options = {}) => {
    const response = await fetch(origin + path + (query ? '?' + query : ''), {
      method: options.method || 'GET', headers: { Authorization: 'Bearer ' + token, ...options.headers },
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length <= facadeModule.MAX_RESPONSE_BYTES, 'actual HTTP response stays inside the unchanged frame limit')
    return { status: response.status, body: JSON.parse(bytes) }
  }
  return { state, calls, call, native, facade, relisten: async () => { ({ origin, token } = await facade.listen()) } }
}

test('native desktop tree topology, full Unicode context and idle activity survive real HTTP paging', async t => {
  const original = workspace(), f = await fixture(t, original)
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > facadeModule.MAX_RESPONSE_BYTES)
  assert.deepEqual(await f.call(), { status: 500, body: { ok: false, error: { code: 'AGENT_FACADE_RESPONSE_TOO_LARGE' } } })
  let first
  const chunks = []
  for (let page = 0; ; page += 1) {
    const answer = await f.call(new URLSearchParams({ page: String(page), ...(first ? { snapshot: first.sha256 } : {}) }))
    assert.equal(answer.status, 200)
    const part = answer.body.desktopTreeSnapshot
    assert.equal(part.version, 1)
    first ||= part
    assert.equal(part.sha256, first.sha256)
    assert.equal(part.page, page)
    assert.equal(part.pages, first.pages)
    assert.equal(part.bytes, first.bytes)
    const chunk = Buffer.from(part.data, 'base64')
    assert.equal(chunk.length, Math.min(CHUNK, part.bytes - page * CHUNK))
    chunks.push(chunk)
    if (page + 1 === first.pages) break
  }
  const bytes = Buffer.concat(chunks)
  assert.equal(bytes.length, first.bytes)
  assert.equal(digest(bytes), first.sha256)
  assert.deepEqual(JSON.parse(bytes), original, 'no hierarchy, drafts, terminal nodes, context or native activity is reconstructed or dropped')
  assert.ok(first.pages > 1)
  for (const call of f.calls) {
    assert.equal(call.command, 'agent:desktop-tree')
    assert.deepEqual(call.payload, {}, 'paging cannot select a different native store, account or computer')
    assert.equal(call.principal.mayWrite, false)
  }
})

test('small desktop snapshots keep their ordinary command response and do not require write access', async t => {
  const original = { ok: true, mayWrite: false, desktopTree: { version: 1, computerId: 'this-computer', trees: [], nodes: [] }, sessions: [], sessionsTruncated: false }
  const f = await fixture(t, original)
  assert.deepEqual(await f.call(), { status: 200, body: original })
  assert.equal(f.calls.length, 1)
})

test('desktop-tree requests refuse unauthorized callers and invalid paging before native reads', async t => {
  const f = await fixture(t)
  for (const [options, status] of [
    [{ headers: { Authorization: '' } }, 401],
    [{ headers: { Authorization: 'Bearer invalid' } }, 401],
    [{ headers: { Origin: 'https://toolsenabled.ai' } }, 403],
    [{ method: 'POST' }, 405],
  ]) assert.equal((await f.call('page=0', options)).status, status)
  for (const query of ['page=-1', 'page=1.5', `page=${MAX / CHUNK}`, 'page=0&page=1', 'page=1', 'page=1&snapshot=no',
    'snapshot=' + 'a'.repeat(64), 'page=0&snapshot=' + 'a'.repeat(64), 'page=0&account=other',
    'page=0&computerId=other', 'key=mc.fleet.trees.v1:other', 'page=0&limit=2', 'page=0&__proto__=x',
    'page=0&constructor=x', 'page=0&toString=x', 'page=1&snapshot=' + 'a'.repeat(64) + '&snapshot=' + 'b'.repeat(64)]) {
    assert.equal((await f.call(query)).status, 400, query)
  }
  assert.equal(f.calls.length, 0)
})

test('a running tree can complete a point-in-time transfer while replies and parent links change', async t => {
  const f = await fixture(t)
  const first = (await f.call('page=0')).body.desktopTreeSnapshot
  const chunks = [Buffer.from(first.data, 'base64')]
  for (let page = 1; page < first.pages; page += 1) {
    f.state.answer = { ...workspace(), sessions: [{ sessionId: 'native-child', busy: true, turnsCompleted: page }] }
    f.state.answer.desktopTree.nodes[2].parentId = 'parent'
    const answer = await f.call(`page=${page}&snapshot=${first.sha256}`)
    assert.equal(answer.status, 200)
    chunks.push(Buffer.from(answer.body.desktopTreeSnapshot.data, 'base64'))
  }
  const restored = Buffer.concat(chunks)
  assert.equal(digest(restored), first.sha256)
  assert.deepEqual(JSON.parse(restored), workspace())
  assert.equal(f.calls.length, 1, 'one native data read, with no repeated whole-tree serialization')
  assert.equal(f.state.leaseChecks, first.pages, 'every page checks original native pairing authority')
})

test('invalid continuation pages and native refusals do not become partial or empty trees', async t => {
  const f = await fixture(t, { ok: true, desktopTree: { version: 1, computerId: 'this-computer', trees: [], nodes: [] } })
  const first = (await f.call('page=0')).body.desktopTreeSnapshot
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 400)
  f.state.answer = { ok: false, code: 'MC_AGENT_DESKTOP_TREE_DAMAGED' }
  assert.deepEqual((await f.call('page=0')).body, f.state.answer)
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409)
})

test('desktop snapshots beyond the native-record transfer bound refuse without truncating topology', async t => {
  const f = await fixture(t, { ok: true, desktopTree: { reply: 'x'.repeat(MAX) } })
  assert.deepEqual(await f.call('page=0'), { status: 500, body: { ok: false, error: { code: 'AGENT_FACADE_RESPONSE_TOO_LARGE' } } })
})

for (const change of ['owner', 'device', 'pair', 'generation', 'grant', 'native-close']) {
  test(`cached native tree refuses a ${change} change even when the underlying bytes are identical`, async t => {
    const f = await fixture(t)
    const first = (await f.call('page=0')).body.desktopTreeSnapshot
    if (change === 'owner') f.state.principal = { ...f.state.principal, owner: {} }
    if (change === 'device') f.state.deviceId = 'device-b'
    if (change === 'pair') f.state.pairId = 'pair-b'
    if (change === 'generation') f.state.generation += 1
    if (change === 'grant') f.state.principal = { ...f.state.principal, mayWrite: true }
    if (change === 'native-close') f.native.close()
    const answer = await f.call('page=1&snapshot=' + first.sha256)
    assert.equal(answer.body.ok, false)
    assert.match(answer.body.error.code, /MC_AGENT_CONNECTION_CLOSED|AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_CHANGED/)
    assert.equal(f.calls.length, 1, 'refused continuation does not read another account tree')
    assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409, 'refusal discards the cached body')
  })
}

test('snapshot expiry is fixed and a new capture explicitly replaces the old one', async t => {
  const f = await fixture(t)
  const first = (await f.call('page=0')).body.desktopTreeSnapshot
  f.state.now = 30 * 60000 - 1
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 200)
  f.state.now = 30 * 60000
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409, 'reading a page never extends retention')
  f.state.answer = { ...workspace(), mayWrite: true }
  const replacement = (await f.call('page=0')).body.desktopTreeSnapshot
  assert.notEqual(replacement.sha256, first.sha256)
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('single-flight snapshot capture refuses a second allocation until the first capture settles', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.state.beforeRead = async () => { entered.resolve(); await release.promise }
  const first = f.call('page=0')
  await entered.promise
  assert.deepEqual(await f.call('page=0'), { status: 409, body: { ok: false, error: { code: 'AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_BUSY' } } })
  assert.equal(f.calls.length, 1)
  release.resolve()
  assert.equal((await first).status, 200)
})

test('replacement during a paused lease check cannot resurrect the retired buffer', async t => {
  const f = await fixture(t), first = (await f.call('page=0')).body.desktopTreeSnapshot
  const entered = deferred(), release = deferred()
  f.state.beforeCheck = async () => { f.state.beforeCheck = null; entered.resolve(); await release.promise }
  const continuation = f.call('page=1&snapshot=' + first.sha256)
  await entered.promise
  f.state.answer = { ...workspace(), sessions: [] }
  const replacement = (await f.call('page=0')).body.desktopTreeSnapshot
  release.resolve()
  assert.equal((await continuation).status, 409)
  assert.equal((await f.call('page=1&snapshot=' + replacement.sha256)).status, 200, 'old refusal cannot erase the new capture')
})

test('close removes a cached snapshot across listen-token replacement', async t => {
  const f = await fixture(t), first = (await f.call('page=0')).body.desktopTreeSnapshot
  await f.facade.close()
  await f.relisten()
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409)
  assert.equal(f.calls.length, 1)
})

test('a late old snapshot cursor cannot discard the replacement snapshot', async t => {
  const f = await fixture(t), first = (await f.call('page=0')).body.desktopTreeSnapshot
  f.state.answer = { ...workspace(), sessions: [] }
  const replacement = (await f.call('page=0')).body.desktopTreeSnapshot
  assert.notEqual(first.sha256, replacement.sha256)
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409)
  assert.equal((await f.call('page=1&snapshot=' + replacement.sha256)).status, 200)
})

test('close and relisten cannot allocate a second large capture while the old source read is pending', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.state.beforeRead = async () => { f.state.beforeRead = null; entered.resolve(); await release.promise }
  const pending = f.call('page=0').catch(() => null)
  await entered.promise
  await f.facade.close()
  await f.relisten()
  const second = await f.call('page=0')
  const reads = f.calls.length
  release.resolve()
  await pending
  // Allow the old native read's finally to release its allocation sentinel.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_BUSY')
  assert.equal(reads, 1)
  assert.equal((await f.call('page=0')).status, 200)
})

test('a native-record-sized transfer fits its fixed budget with a one-second native check per page', async t => {
  // The data source is synthetic; actual HTTP framing and the real native
  // lease run on every page. Advance only the monotonic retention clock to
  // model the documented vault-process cost without sleeping for 17 minutes.
  const f = await fixture(t, { ...workspace(), transferBudgetFixture: 'x'.repeat(64 * 1024 * 1024 - 1024 * 1024) })
  const first = (await f.call('page=0')).body.desktopTreeSnapshot
  assert.ok(first.pages > 1000 && first.pages <= 1040)
  const hash = createHash('sha256').update(Buffer.from(first.data, 'base64'))
  for (let page = 1; page < first.pages; page += 1) {
    f.state.now += 1000
    const answer = await f.call(`page=${page}&snapshot=${first.sha256}`)
    assert.equal(answer.status, 200, `page ${page}`)
    hash.update(Buffer.from(answer.body.desktopTreeSnapshot.data, 'base64'))
  }
  assert.equal(hash.digest('hex'), first.sha256)
  assert.equal(f.calls.length, 1)
  assert.equal(f.state.leaseChecks, first.pages)
  f.state.now = 30 * 60000
  assert.equal((await f.call('page=1&snapshot=' + first.sha256)).status, 409)
})
