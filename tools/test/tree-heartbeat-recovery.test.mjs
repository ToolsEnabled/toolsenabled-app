import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib')
const ENGINE = path.join(FIXTURE, 'agent-engine/codex-process.js')
const DIRECTORY = path.join(FIXTURE, 'agent-comms/tree-node-directory.js')
const directoryModule = require_(DIRECTORY)
const provider = require_(path.join(FIXTURE, 'providers/agent-comms-local.js'))
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))

async function until(predicate, description, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail(description)
}

async function setup(t, { batch = true, batchFailure = false, heartbeatMs = 80, foundOnly = false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'page2-heartbeat-'))
  directoryModule.reset()
  provider.reset()
  const calls = { batches: [], batchReadCounts: [], singles: 0 }
  const base = directoryModule.createTreeNodeDirectory()
  const beat = request => {
    const node = base.listNodes().find(node => node.sessionId === request.sessionId)
    return {
      agentId: directoryModule.agentIdForSession(request.sessionId), found: Boolean(node),
      ...(foundOnly ? {} : { live: Boolean(node && node.stoppedAt === null) }),
    }
  }
  require_.cache[require_.resolve(DIRECTORY)].exports = {
    ...directoryModule,
    createTreeNodeDirectory: () => ({
      ...base,
      heartbeatNode: request => { calls.singles += 1; return beat(request) },
      ...(batch ? { heartbeatNodes: requests => {
        calls.batches.push(requests.map(request => request.sessionId))
        calls.batchReadCounts.push(provider.readCount())
        if (batchFailure) throw new Error('directory temporarily unavailable')
        return requests.map(beat)
      } } : {}),
    }),
  }
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE, defaultCwd: scratch,
    confinementPlanner: () => ({
      ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: {}, servers: ['toolsenabled-readonly', 'toolsenabled'],
    }),
    treeCourier: { pollMs: 25, heartbeatMs, readDeadlineMs: 250 },
  })
  t.after(async () => {
    provider.releaseReads()
    await host.closeAll().catch(() => {})
    require_.cache[require_.resolve(DIRECTORY)].exports = directoryModule
    directoryModule.reset()
    provider.reset()
    rmSync(scratch, { recursive: true, force: true })
  })
  for (const sessionId of ['manager', 'worker']) {
    await host.startSession({ sessionId, treeIdentity: { selfName: sessionId, managerName: sessionId === 'worker' ? 'manager' : null } })
  }
  assert.equal(base.listNodes().length, 2)
  return { host, base, calls }
}

test('heartbeats run as a single batch before a stalled inbox read', async t => {
  const { calls } = await setup(t, { heartbeatMs: 1 })
  provider.holdReads()
  await until(() => calls.batches.length > 0, 'no heartbeat batch was sent')
  assert.equal(calls.singles, 0, 'a batch must not be followed by one write per circle')
  assert.equal(calls.batchReadCounts[0], 0, 'the first due heartbeat must precede the held read')
  assert.ok(calls.batches.some(ids => ids.length === 2), 'the two due sessions must share the durable write')
});

for (const batch of [true, false]) {
  test(`a ${batch ? 'batch' : 'single-session'} heartbeat repairs a lost directory row without replacing the agent`, async t => {
    const { base } = await setup(t, { batch })
    directoryModule.reset()
    await until(() => base.listNodes().length === 2, 'the live sessions never re-registered after their rows disappeared')
    assert.deepEqual(base.listNodes().map(node => node.sessionId).sort(), ['manager', 'worker'])
  })
  test(`a ${batch ? 'batch' : 'single-session'} heartbeat repairs a stopped row for a session still owned by the host`, async t => {
    const { base } = await setup(t, { batch })
    base.unregisterNode({ sessionId: 'worker' })
    await until(() => base.listNodes().find(node => node.sessionId === 'worker')?.stoppedAt === null,
      'a retained stopped row was mistaken for a reachable live session')
  })
}

test('an older payload with found-only heartbeats still renews and repairs missing rows', async t => {
  const { base, calls } = await setup(t, { batch: false, foundOnly: true })
  await until(() => calls.singles >= 2, 'the older single-session heartbeat was not called')
  assert.equal(directoryModule.registrationAttempts().length, 2, 'absence of the new live field is not evidence of a lost row')
  directoryModule.reset()
  await until(() => base.listNodes().length === 2, 'a found:false result from an older engine never triggered recovery')
});

test('a failed batch does not retry every circle individually in the same round', async t => {
  const { calls } = await setup(t, { batchFailure: true })
  await until(() => calls.batches.length >= 2, 'a failed heartbeat batch was not retried')
  assert.equal(calls.singles, 0, 'one failed lock attempt must not fan out into N more blocking attempts')
});
