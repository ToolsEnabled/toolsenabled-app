import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { test } from 'node:test'
/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const engineRoot = process.env.MC_CANONICAL_ROOT || path.join(root, 'capability')
const realDirectoryModule = require_(path.join(engineRoot, 'src/lib/agent-comms/tree-node-directory.js'))
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
const fixtureRoot = path.join(root, 'tools/test/fixtures/confined-engine')
const enginePath = path.join(fixtureRoot, 'src/lib/agent-engine/codex-process.js')
const directoryPath = path.join(fixtureRoot, 'src/lib/agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtureRoot, 'src/lib/providers/agent-comms-local.js')

// Only the provider engine and inbox are fixtures. The shell and all durable
// directory registration, validation, replacement, and routing are production.
async function withHost(run, { failRegistrations = 0 } = {}) {
  const workdir = mkdtempSync(path.join(tmpdir(), 'host-tree-identity-'))
  const file = path.join(workdir, 'tree-nodes.json')
  const directory = realDirectoryModule.createTreeNodeDirectory({ file })
  const fixtureExports = require_(directoryPath)
  const cached = require_.cache[require_.resolve(directoryPath)]
  const provider = require_(providerPath)
  provider.reset()
  cached.exports = {
    ...realDirectoryModule,
    createTreeNodeDirectory(options) {
      const real = realDirectoryModule.createTreeNodeDirectory({ ...options, file })
      return {
        ...real,
        registerNode(request) {
          if (failRegistrations > 0) {
            failRegistrations -= 1
            throw Object.assign(new Error('injected transient write refusal'), { code: 'TREE_DIRECTORY_BUSY' })
          }
          return real.registerNode(request)
        },
      }
    },
  }
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath, defaultCwd: workdir,
    treeCourier: { pollMs: 100, heartbeatMs: 1000 },
    confinementPlanner: () => ({
      ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(workdir, 'agent-home') },
      servers: ['toolsenabled-readonly', 'toolsenabled'],
    }),
  })
  try { await run({ host, directory }) } finally {
    await host.closeAll().catch(() => {})
    cached.exports = fixtureExports
    provider.reset()
    rmSync(workdir, { recursive: true, force: true })
  }
}

const controllerStart = (sessionId, extra = {}) => ({
  sessionId,
  requestKeys: { treeAnchors: ['controller-node'], threadId: 'controller-node' },
  treeIdentity: { selfName: 'Controller', managerName: null },
  ...extra,
})

const adoption = (sessionId, nodeId = 'adopted-node', parentId = null) => ({
  sessionId, selfName: 'Independent agent', managerName: parentId ? 'Controller' : null,
  treeKey: parentId || nodeId,
  requestKeys: { treeAnchors: parentId ? [parentId, nodeId] : [nodeId], threadId: nodeId },
})

test('a standalone session can become a root or child without restarting, sending or changing its conversation', async () => {
  for (const parent of [null, 'existing-root']) await withHost(async ({ host, directory }) => {
    const engine = require_(enginePath)
    const started = await host.startSession({ sessionId: 'independent' })
    const starts = engine.calls.length, actions = engine.adapterCalls.length
    const request = adoption('independent', 'adopted-node', parent)
    const result = host.adoptTreeAddress(request)
    assert.equal(result.sessionId, started.sessionId)
    assert.equal(result.threadId, started.threadId)
    assert.equal(result.account, started.account)
    assert.equal(result.effort, started.effort)
    assert.equal(result.nodeId, 'adopted-node')
    assert.equal(result.phase, 'open')
    assert.equal(result.provider, 'codex')
    const row = directory.listNodes().find(row => row.sessionId === 'independent')
    assert.equal(row.nodeKey, 'adopted-node')
    assert.equal(row.treeKey, request.treeKey)
    assert.equal(row.managerName, request.managerName)
    assert.equal(row.threadId, started.threadId)
    assert.deepEqual(host.adoptTreeAddress(request), result, 'an exact repeated handoff is idempotent')
    assert.equal(directory.listNodes().length, 1)
    assert.equal(engine.calls.length, starts)
    assert.equal(engine.adapterCalls.length, actions)
    await host.sendTurn({ sessionId: 'independent', text: 'Continue the same conversation.' })
    const turn = engine.adapterCalls.at(-1).request
    assert.match(turn.text, /Continue the same conversation/)
    assert.match(turn.text, /added this existing conversation to a saved tree/)
    assert.match(turn.text, parent ? /now report to "Controller"/ : /top agent of this tree/)
    assert.equal(engine.calls.length, starts)
  })
})

test('adoption during an existing turn does not interrupt it or lose its busy state', async () => {
  await withHost(async ({ host, directory }) => {
    const engine = require_(enginePath)
    await host.startSession({ sessionId: 'busy-independent' })
    await host.sendTurn({ sessionId: 'busy-independent', text: 'Keep working on this task.' })
    const before = { starts: engine.calls.length, actions: engine.adapterCalls.length, activity: host.sessionActivity('busy-independent') }
    assert.equal(before.activity.busy, true)
    const result = host.adoptTreeAddress(adoption('busy-independent', 'busy-node', 'existing-root'))
    assert.equal(result.phase, 'working')
    assert.deepEqual(host.sessionActivity('busy-independent'), before.activity)
    assert.equal(engine.calls.length, before.starts)
    assert.equal(engine.adapterCalls.length, before.actions)
    assert.equal(directory.listNodes()[0].nodeKey, 'busy-node')
  })
})

test('a refused initial directory write leaves no pending adoption and can be retried explicitly', async () => {
  await withHost(async ({ host, directory }) => {
    await host.startSession({ sessionId: 'retry-independent' })
    assert.throws(() => host.adoptTreeAddress(adoption('retry-independent')), { code: 'TREE_DIRECTORY_BUSY' })
    assert.equal(host.sessionIsOnTree('retry-independent'), false)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(directory.listNodes().length, 0, 'a refused adoption must not later register its rolled-back draft')
    assert.equal(host.adoptTreeAddress(adoption('retry-independent')).ok, true)
    assert.equal(directory.listNodes()[0].nodeKey, 'adopted-node')
  }, { failRegistrations: 1 })
})

test('missing sessions, invalid ancestry, occupied nodes and different saved assignments cannot be adopted', async () => {
  await withHost(async ({ host, directory }) => {
    assert.throws(() => host.adoptTreeAddress(adoption('missing')), { code: 'AGENT_SESSION_UNKNOWN' })
    await host.startSession({ sessionId: 'independent' })
    const request = adoption('independent')
    for (const changed of [
      { requestKeys: null }, { treeKey: 'wrong-root' },
      { requestKeys: { treeAnchors: ['adopted-node'], threadId: 'wrong-node' } },
      { requestKeys: { treeAnchors: ['adopted-node', 'adopted-node'], threadId: 'adopted-node' } },
      { requestKeys: { treeAnchors: ['adopted-node'], threadId: 'adopted-node', credential: 'not-accepted' } },
    ]) assert.throws(() => host.adoptTreeAddress({ ...request, ...changed }), { code: 'AGENT_REQUEST_KEYS_INVALID' })
    assert.equal(directory.listNodes().length, 0)
    host.adoptTreeAddress(request)
    assert.throws(() => host.adoptTreeAddress(adoption('independent', 'different-node')), { code: 'AGENT_TREE_ALREADY_ASSIGNED' })
    await host.startSession({ sessionId: 'second-independent' })
    assert.throws(() => host.adoptTreeAddress(adoption('second-independent')), { code: 'AGENT_TREE_NODE_OCCUPIED' })
    assert.equal(host.sessionIsOnTree('second-independent'), false)
    assert.equal(directory.listNodes().length, 1)
    host.updateTreeAddress({ ...request, managerName: 'New manager', treeKey: 'new-root', requestKeys: { treeAnchors: ['new-root', 'adopted-node'], threadId: 'adopted-node' } })
    assert.equal(directory.listNodes()[0].nodeKey, 'adopted-node', 'later moves retain the adopted identity')
    await host.closeSession({ sessionId: 'second-independent' })
    assert.throws(() => host.adoptTreeAddress(adoption('second-independent', 'closed-node')), error => /^AGENT_SESSION_(UNKNOWN|ENDED|NOT_READY)$/.test(error.code))
  })
})

test('a fresh host replacement removes its exact legacy Controller row and keeps the saved node key', async () => {
  await withHost(async ({ host, directory }) => {
    directory.registerNode({ sessionId: 'legacy-controller', nodeName: 'Controller', pid: process.pid })
    await host.startSession(controllerStart('replacement-controller', { replacesSessionId: 'legacy-controller' }))
    assert.deepEqual(directory.listNodes().map(row => row.sessionId), ['replacement-controller'])
    assert.equal(directory.listNodes()[0].nodeKey, 'controller-node')
    host.updateTreeAddress({ sessionId: 'replacement-controller', selfName: 'Controller', managerName: 'Manager', treeKey: 'moved-root' })
    const row = directory.listNodes()[0]
    assert.equal(row.treeKey, 'moved-root')
    assert.equal(row.nodeKey, 'controller-node', 'moving a session must not discard its saved circle identity')
  })
})

test('a transient replacement refusal retains the exact predecessor until the retry lands', async () => {
  await withHost(async ({ host, directory }) => {
    directory.registerNode({ sessionId: 'legacy-controller', nodeName: 'Controller', pid: process.pid })
    await host.startSession(controllerStart('retried-controller', { replacesSessionId: 'legacy-controller' }))
    assert.equal(directory.listNodes()[0].sessionId, 'legacy-controller')
    assert.equal(directory.listNodes()[0].live, true, 'an atomic replacement refusal must not stop the old row')
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && !directory.listNodes().some(row => row.sessionId === 'retried-controller')) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(directory.listNodes().map(row => row.sessionId), ['retried-controller'])
  }, { failRegistrations: 1 })
})

test('resuming a copied conversation under a different saved circle never unregisters its source', async () => {
  await withHost(async ({ host, directory }) => {
    directory.registerNode({ sessionId: 'source', nodeName: 'Manager', pid: process.pid,
      nodeKey: 'source-node', treeKey: 'source-node', threadId: 'copied-conversation' })
    await host.startSession({
      sessionId: 'copy', resumeThreadId: 'copied-conversation',
      requestKeys: { treeAnchors: ['copy-node'], threadId: 'copy-node' },
      treeIdentity: { selfName: 'Manager', managerName: null },
    })
    const source = directory.listNodes().find(row => row.sessionId === 'source')
    assert.ok(source?.live, 'the copied conversation stopped the separate source circle')
    assert.equal(directory.listNodes().find(row => row.sessionId === 'copy')?.nodeKey, 'copy-node')
  })
})
