import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engineRoot = process.env.MC_CANONICAL_ROOT || path.join(root, 'capability')
const directoryModule = require_(path.join(engineRoot, 'src/lib/agent-comms/tree-node-directory.js'))
const fixtureRoot = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const directoryPath = path.join(fixtureRoot, 'agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtureRoot, 'providers/agent-comms-local.js')
const enginePath = path.join(fixtureRoot, 'agent-engine/codex-process.js')
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))

async function fixture(t, { batch = false, failFirstOldRead = false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'tree-predecessor-'))
  const file = path.join(scratch, 'tree-nodes.json')
  let clockOffset = 0
  const now = () => Date.now() + clockOffset
  const directory = directoryModule.createTreeNodeDirectory({ file, now })
  const originalDirectory = require_(directoryPath)
  const originalProvider = require_(providerPath)
  const engine = require_(enginePath)
  originalProvider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  engine.pendingTurns.length = 0
  engine.control.holdTurns = false
  require_.cache[require_.resolve(directoryPath)].exports = {
    ...directoryModule,
    createTreeNodeDirectory: options => directoryModule.createTreeNodeDirectory({ ...options, file, now }),
  }
  const reads = []
  const batches = []
  let injected = false
  const inbox = async request => {
    reads.push({ ...request })
    if (failFirstOldRead && !injected && request.agentId === directory.agentIdForSession('old')) {
      injected = true
      throw new Error('temporary predecessor inbox read refusal')
    }
    return originalProvider.inbox(request)
  }
  require_.cache[require_.resolve(providerPath)].exports = {
    ...originalProvider, inbox,
    ...(batch ? { inboxes: async requests => {
      batches.push(requests.map(request => ({ ...request })))
      const answers = []
      for (const request of requests) {
        try { answers.push({ agentId: request.agentId, ...(await inbox(request)) }) }
        catch { /* An omitted page is not an empty page. */ }
      }
      return answers
    } } : {}),
  }
  const host = createAgentHost({
    enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 * 1024 * 1024,
    treeCourier: { pollMs: 30, heartbeatMs: 1000, readDeadlineMs: 300 },
    confinementPlanner: () => ({
      ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') },
      servers: ['toolsenabled-readonly', 'toolsenabled'],
    }),
  })
  const visible = []
  const unlisten = host.onEvent(event => visible.push(event))
  t.after(async () => {
    originalProvider.releaseReads()
    await host.closeAll()
    unlisten()
    require_.cache[require_.resolve(directoryPath)].exports = originalDirectory
    require_.cache[require_.resolve(providerPath)].exports = originalProvider
    originalProvider.reset()
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  const register = (sessionId, extra = {}) => directory.registerNode({
    sessionId, nodeName: 'Worker', managerName: null, pid: process.pid,
    nodeKey: 'worker-node', treeKey: 'worker-node', ...extra,
  })
  const start = () => host.startSession({
    sessionId: 'replacement', replacesSessionId: 'old',
    treeIdentity: { selfName: 'Worker', managerName: null },
    requestKeys: { treeAnchors: ['worker-node'], threadId: 'worker-node' },
  })
  const deliver = (recipient, body) => originalProvider.deliver({
    recipientAgentId: directory.agentIdForSession(recipient), senderAgentId: 'retained-sender', body,
  })
  return { host, directory, engine, reads, batches, visible, register, start, deliver,
    advanceClock: milliseconds => { clockOffset += milliseconds } }
}

function bodies(engine) {
  return engine.adapterCalls.filter(call => call.method === 'sendTurn' || call.method === 'steerTurn')
    .map(call => call.request.text)
}

async function until(predicate, message) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail(message)
}

for (const batch of [false, true]) {
  test(`replacement reads a pre-replacement message through the ${batch ? 'batch' : 'single'} inbox path once`, async t => {
    const f = await fixture(t, { batch })
    const before = f.register('old')
    f.deliver('old', 'Result queued before replacement: 731.')
    await f.start()
    const after = f.directory.listNodes().find(row => row.sessionId === 'replacement')
    assert.notEqual(before.agentId, after.agentId, 'the scenario must replace the actual inbox address')
    await until(() => bodies(f.engine).some(text => text.includes('Result queued before replacement: 731.')),
      'a message in the predecessor inbox never reached the replacement model')
    await delay(120)
    assert.equal(bodies(f.engine).join('\n').split('Result queued before replacement: 731.').length - 1, 1)
    assert.match(bodies(f.engine).join('\n'), /recovered.*previous session/i,
      'recovery provenance must be visible because the prior handoff may have succeeded before it ended')
    const reads = f.reads.filter(request => request.agentId === before.agentId)
    assert.ok(reads.some(request => request.cursor === 0))
    assert.ok(reads.some(request => request.cursor > 0), 'a drained predecessor is checked from its own advanced cursor')
  })
}

test('an omitted predecessor page is retried while its cursor remains unchanged', async t => {
  const f = await fixture(t, { batch: true, failFirstOldRead: true })
  const old = f.register('old')
  f.deliver('old', 'Retry the retained inbox: 942.')
  await f.start()
  await until(() => bodies(f.engine).some(text => text.includes('Retry the retained inbox: 942.')),
    'an omitted predecessor page was mistaken for a drained inbox')
  const reads = f.reads.filter(request => request.agentId === old.agentId)
  assert.equal(reads[0].cursor, 0)
  assert.equal(reads[1].cursor, 0)
  assert.equal(bodies(f.engine).join('\n').split('Retry the retained inbox: 942.').length - 1, 1)
})

test('predecessor and current inbox cursors cannot hide a lower sequence in the other stream', async t => {
  const f = await fixture(t, { batch: true })
  f.register('old')
  f.deliver('replacement', 'Current inbox sequence: 118.')
  f.deliver('old', 'Predecessor inbox sequence: 119.')
  await f.start()
  await until(() => bodies(f.engine).join('\n').includes('Current inbox sequence: 118.')
    && bodies(f.engine).join('\n').includes('Predecessor inbox sequence: 119.'),
  'an independently positioned inbox was skipped by the other inbox cursor')
  assert.equal(bodies(f.engine).join('\n').split('Current inbox sequence: 118.').length - 1, 1)
  assert.equal(bodies(f.engine).join('\n').split('Predecessor inbox sequence: 119.').length - 1, 1)
})

test('a replacement recovers both hops of its retained same-node history', async t => {
  const f = await fixture(t, { batch: true })
  f.register('grandparent')
  f.deliver('grandparent', 'First retained inbox: 420.')
  f.register('old', { replacesSessionId: 'grandparent' })
  f.deliver('old', 'Second retained inbox: 421.')
  await f.start()
  await until(() => bodies(f.engine).join('\n').includes('First retained inbox: 420.')
    && bodies(f.engine).join('\n').includes('Second retained inbox: 421.'),
  'the intermediate replacement hid an earlier retained inbox')
  assert.equal(bodies(f.engine).join('\n').split('First retained inbox: 420.').length - 1, 1)
  assert.equal(bodies(f.engine).join('\n').split('Second retained inbox: 421.').length - 1, 1)
})

test('the courier never reads a retained inbox belonging to another stable node', async t => {
  const f = await fixture(t, { batch: true })
  const unrelated = f.register('unrelated', { nodeName: 'Other', nodeKey: 'other-node', treeKey: 'other-node' })
  f.register('other-replacement', { nodeName: 'Other', nodeKey: 'other-node', treeKey: 'other-node', replacesSessionId: 'unrelated' })
  f.deliver('unrelated', 'Different circle private work: 514.')
  f.register('old')
  f.deliver('old', 'This circle pending work: 515.')
  await f.start()
  await until(() => bodies(f.engine).join('\n').includes('This circle pending work: 515.'), 'the fixture did not recover its own predecessor')
  await delay(120)
  assert.equal(f.reads.filter(read => read.agentId === unrelated.agentId).length, 0)
  assert.equal(bodies(f.engine).join('\n').includes('Different circle private work: 514.'), false)
})

test('a packet already in flight to the old address is recovered after an empty page', async t => {
  const f = await fixture(t, { batch: true })
  const old = f.register('old')
  f.deliver('old', 'First old packet: 611.')
  await f.start()
  await until(() => bodies(f.engine).join('\n').includes('First old packet: 611.')
    && f.reads.some(read => read.agentId === old.agentId && read.cursor > 0),
  'the fixture did not reach its empty old-inbox page')
  f.engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
  f.deliver('old', 'Late old packet: 612.')
  await until(() => bodies(f.engine).join('\n').includes('Late old packet: 612.'),
    'an empty page retired an address while an already-started delivery could still arrive')
  assert.equal(bodies(f.engine).join('\n').split('First old packet: 611.').length - 1, 1)
  assert.equal(bodies(f.engine).join('\n').split('Late old packet: 612.').length - 1, 1)
})

test('bounded recovery rotates past four quiet predecessors and keeps watching the earlier aliases', async t => {
  const f = await fixture(t, { batch: true })
  const history = ['first', 'second', 'third', 'fourth', 'fifth', 'old']
  for (const [index, sessionId] of history.entries()) {
    f.register(sessionId, index ? { replacesSessionId: history[index - 1] } : {})
  }
  await f.start()
  await until(() => history.every(sessionId => f.reads.some(read => read.agentId === f.directory.agentIdForSession(sessionId))),
    'quiet earlier aliases starved a later predecessor')
  f.deliver('first', 'Late first alias after rotation: 701.')
  f.deliver('fifth', 'Late fifth alias after rotation: 702.')
  await until(() => bodies(f.engine).some(text => /Late (first|fifth) alias after rotation/.test(text)),
    'none of the late packets reached the replacement')
  // The two aliases can be read on different rounds. Finish the first model
  // turn so its normal boundary admits the other recovered message.
  f.engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
  await until(() => bodies(f.engine).join('\n').includes('Late first alias after rotation: 701.')
    && bodies(f.engine).join('\n').includes('Late fifth alias after rotation: 702.'),
  'a previously empty alias stopped being watched after a rotation')
  assert.ok(f.batches.every(batch => batch.length <= 5), 'one circle may read at most four old inboxes plus its current inbox per round')
  assert.ok(f.batches.every(batch => batch.some(read => read.agentId === f.directory.agentIdForSession('replacement'))),
    'predecessor recovery must not starve the current inbox')
  assert.equal(bodies(f.engine).join('\n').split('Late first alias after rotation: 701.').length - 1, 1)
  assert.equal(bodies(f.engine).join('\n').split('Late fifth alias after rotation: 702.').length - 1, 1)
})

test('the courier stops reading an old inbox once its same-node tombstone expires', async t => {
  const f = await fixture(t, { batch: true })
  const old = f.register('old')
  await f.start()
  await until(() => f.reads.some(read => read.agentId === old.agentId), 'the fixture did not watch the retained alias')
  f.advanceClock(directoryModule.STOPPED_RETENTION_MS + 1)
  f.directory.heartbeatNode({ sessionId: 'replacement' })
  assert.equal(f.directory.successorOf(old.agentId), null, 'the real directory must refuse the expired alias')
  const priorReadCount = f.reads.filter(read => read.agentId === old.agentId).length
  f.deliver('old', 'Outside retained lineage: 801.')
  await delay(180)
  assert.equal(f.reads.filter(read => read.agentId === old.agentId).length, priorReadCount,
    'the courier kept using an alias after its forwarding window expired')
  assert.equal(bodies(f.engine).join('\n').includes('Outside retained lineage: 801.'), false)
})
