import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAgentHost } from '../../shell/agent-host.cjs'

const require = createRequire(import.meta.url)
const ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const engine = require(ENGINE)
const directory = require('./fixtures/confined-engine/src/lib/agent-comms/tree-node-directory.js')
const { rootLifecycle, control } = require('./fixtures/dual-engine/root-lifecycle.cjs')
// These execute the real application guard through the existing in-process
// provider lifecycle fixture. They do not claim OS process/sandbox evidence.
const ISSUED = Buffer.alloc(32, 0x52).toString('base64url') // Synthetic, never an account credential.
const permission = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' })
const refusal = () => Object.assign(new Error('Synthetic inherited authority revoked'), { code: 'TREE_DELEGATION_REFUSED' })

function request(sessionId = 'scope-parent') {
  return { sessionId, agentId: 'scope-agent', role: { id: 'worker', name: 'Worker', owns: 'Scope tests', mustNot: 'Widen authority', handoff: 'Parent' },
    agentAuthority: { agentId: 'scope-agent', provider: 'codex', roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 },
    requestKeys: { treeAnchors: ['scope-tree', 'scope-node'], threadId: 'scope-node' },
    treeIdentity: { selfName: 'Scope Worker', managerName: null } }
}

async function fixture(t, run, overrides = {}) {
  const workdir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'te-tree-parent-scope-')))
  const calls = []
  const roots = [workdir]
  const researchAccess = Object.freeze({ version: 1, mode: 'clean-room', root: workdir, access: 'read-only' })
  const authority = { scopeVersion: 1, researchAccessVersion: 1,
    bind(...args) { calls.push(['bind', ...args]); return { bound: true, credential: ISSUED } },
    revoke(value) { calls.push(['revoke', value]) },
    assert() { return { valid: true } },
    readScope(value) { calls.push(['readScope', value]); return { permissionSession: permission, workspaceRoots: roots, researchAccess } } }
  const governor = {
    reserve() { calls.push(['reserve']); return { ok: true, token: 'fixture-reservation', state: { mode: 'off' } } },
    revalidate() { calls.push(['revalidate']); return { ok: true } },
    ready() { calls.push(['ready']) }, release() { calls.push(['release']) },
  }
  const previousMarker = engine.ROOT_ADMISSION_CONTRACT_VERSION
  engine.ROOT_ADMISSION_CONTRACT_VERSION = 1
  const originalStart = engine.startCodexSession
  t.mock.method(engine, 'startCodexSession', async options => {
    const lifecycle = await rootLifecycle(options.rootLaunch)
    const result = await originalStart(options)
    return { ...result, close() { result.close(); lifecycle.close() } }
  })
  directory.reset()
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: workdir,
    profileRoot: path.parse(workdir).root, resourceGovernor: governor, sessionAuthority: authority,
    startProviderProbe: () => 'codex',
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' }, env: {}, servers: [] }),
    ...overrides })
  try { await run({ host, calls, roots, authority, workdir, researchAccess }) }
  finally {
    control.prepare = null
    await host.closeAll()
    directory.reset()
    if (previousMarker === undefined) delete engine.ROOT_ADMISSION_CONTRACT_VERSION
    else engine.ROOT_ADMISSION_CONTRACT_VERSION = previousMarker
    rmSync(workdir, { recursive: true, force: true })
  }
}

test('first tree adoption retains the original credential, provider, folder and permission scope', async t => {
  await fixture(t, async ({ host, calls, roots, workdir, researchAccess }) => {
    const started = await host.startSession({ sessionId: 'standalone-scope' })
    const bound = calls.find(([kind]) => kind === 'bind')
    assert.throws(() => host.readTreeParent('standalone-scope'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
    host.adoptTreeAddress({ sessionId: 'standalone-scope', selfName: 'Independent agent', managerName: 'Controller', treeKey: 'root-node',
      requestKeys: { treeAnchors: ['root-node', 'adopted-node'], threadId: 'adopted-node' } })
    const parent = host.readTreeParent('standalone-scope')
    assert.equal(parent.sessionId, started.sessionId)
    assert.equal(parent.threadId, started.threadId)
    assert.equal(parent.cwd, workdir)
    assert.equal(parent.agentId, bound[1].agentId)
    assert.equal(parent.roleId, bound[1].roleId)
    assert.equal(parent.permissionSession, permission)
    assert.deepEqual(parent.workspaceRoots, roots)
    assert.deepEqual(parent.researchAccess, researchAccess)
    assert.equal(calls.filter(([kind]) => kind === 'bind').length, 1)
    assert.equal(calls.filter(([kind]) => kind === 'revoke').length, 0)
    const scoped = calls.find(([kind]) => kind === 'readScope')[1]
    assert.equal(scoped.credential, ISSUED)
    assert.equal(scoped.provider, bound[1].provider)
    assert.equal(parent.nodeId, 'adopted-node')
    assert.deepEqual(parent.treeAnchors, ['root-node', 'adopted-node'])
  })
})

test('scope v1 forwards the resolved cwd to bind and returns an immutable current tree parent snapshot', async t => {
  await fixture(t, async ({ host, calls, roots, workdir }) => {
    assert.throws(() => host.readTreeParent('missing'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
    await host.startSession(request())
    const binding = calls.find(([kind]) => kind === 'bind')
    assert.deepEqual(binding[2], { workspaceRoot: workdir })
    const parent = host.readTreeParent('scope-parent')
    assert.equal(parent.sessionId, 'scope-parent')
    assert.equal(parent.nodeId, 'scope-node')
    assert.equal(parent.treeId, 'scope-tree')
    assert.equal(parent.agentId, 'scope-agent')
    assert.equal(parent.roleId, 'worker')
    assert.equal(parent.modelTier, null, 'an unspecified model row must not be reported as permission tier standard')
    assert.equal(parent.cwd, workdir)
    assert.deepEqual(parent.treeAnchors, ['scope-tree', 'scope-node'])
    assert.deepEqual(parent.workspaceRoots, [workdir])
    assert.ok(Object.isFrozen(parent) && Object.isFrozen(parent.treeAnchors) && Object.isFrozen(parent.workspaceRoots))
    roots.length = 0
    assert.deepEqual(parent.workspaceRoots, [workdir], 'returned snapshot must not retain the mutable transport array')
    assert.deepEqual(host.readTreeParent('scope-parent').workspaceRoots, [], 'each new read must consult current authority')
    assert.equal(calls.find(([kind]) => kind === 'readScope')[1].credential, ISSUED)
    await host.closeSession({ sessionId: 'scope-parent' })
    assert.throws(() => host.readTreeParent('scope-parent'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
  })
})

test('starting and closing parents cannot issue a trusted tree snapshot', async t => {
  let enter, resume
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  await fixture(t, async ({ host }) => {
    control.prepare = () => { enter(); return gate }
    const starting = host.startSession(request())
    const rejected = assert.rejects(starting, { code: 'AGENT_SESSION_START_CANCELLED' })
    await entered
    assert.throws(() => host.readTreeParent('scope-parent'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
    const stopping = host.closeSession({ sessionId: 'scope-parent' })
    assert.throws(() => host.readTreeParent('scope-parent'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
    resume()
    await rejected
    await stopping
  })
})

test('legacy authority gets no scope or tool-mode bind options and cannot supply a tree delegation scope', async t => {
  await fixture(t, async ({ host, authority, calls }) => {
    delete authority.scopeVersion
    await host.startSession(request())
    // The shared binding carries optional scope and captured tool-mode fields.
    // A legacy authority supports neither, so the options must remain empty.
    assert.deepEqual(calls.find(([kind]) => kind === 'bind')[2], {})
    assert.throws(() => host.readTreeParent('scope-parent'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
  })
})

test('detached sessions and unavailable or asynchronous scope readers refuse parent authority', async t => {
  await fixture(t, async ({ host, authority }) => {
    const detached = request('detached')
    delete detached.treeIdentity
    delete detached.requestKeys
    await host.startSession(detached)
    assert.throws(() => host.readTreeParent('detached'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
    await host.startSession(request())
    for (const readScope of [() => null, () => Promise.resolve({ permissionSession: permission })]) {
      authority.readScope = readScope
      assert.throws(() => host.readTreeParent('scope-parent'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' })
    }
    authority.readScope = () => { throw refusal() }
    assert.throws(() => host.readTreeParent('scope-parent'), { code: 'TREE_DELEGATION_REFUSED' })
  })
})

test('delegation denial at preflight occurs before resource reservation, bind, or fixture root', async t => {
  await fixture(t, async ({ host, calls }) => {
    const rootsBefore = control.roots
    const tiers = []
    assert.throws(() => host.startSession({ ...request(), delegationPermit: {
      assertStart(tier) { tiers.push(tier); throw refusal() }, cancel() {},
    } }), { code: 'TREE_DELEGATION_REFUSED' })
    assert.deepEqual(tiers, ['standard'])
    assert.deepEqual(calls, [])
    assert.equal(control.roots, rootsBefore)
  })
})

test('delegation is rechecked at the final fixture root boundary after async preparation', async t => {
  await fixture(t, async ({ host, calls }) => {
    let revoked = false
    const tiers = []
    const rootsBefore = control.roots
    control.prepare = () => { revoked = true }
    await assert.rejects(host.startSession({ ...request(), delegationPermit: {
      assertStart(tier) { tiers.push(tier); if (revoked) throw refusal() }, cancel() {},
    } }), { code: 'TREE_DELEGATION_REFUSED' })
    assert.deepEqual(tiers, ['standard', 'standard'])
    assert.equal(control.roots, rootsBefore)
    assert.equal(calls.filter(([kind]) => kind === 'release').length, 1)
    assert.equal(calls.some(([kind]) => kind === 'ready'), false)
  })
})

test('an accepted delegation checks both boundaries and reaches a ready fixture session', async t => {
  await fixture(t, async ({ host }) => {
    const tiers = []
    const rootsBefore = control.roots
    await host.startSession({ ...request(), delegationPermit: { assertStart(tier) { tiers.push(tier) }, cancel() {} } })
    assert.deepEqual(tiers, ['standard', 'standard'])
    assert.equal(control.roots, rootsBefore + 1)
    assert.equal(host.readTreeParent('scope-parent').permissionSession.profile, 'workspace')
  })
})

test('final guard sees the credentialed plan tier rather than the stale preflight tier', async t => {
  let plans = 0
  await fixture(t, async ({ host, calls }) => {
    const tiers = []
    const rootsBefore = control.roots
    await assert.rejects(host.startSession({ ...request(), delegationPermit: {
      assertStart(tier) { tiers.push(tier); if (tier !== 'standard') throw refusal() }, cancel() {},
    } }), { code: 'TREE_DELEGATION_REFUSED' })
    assert.deepEqual(tiers, ['standard', 'unrestricted'])
    assert.equal(control.roots, rootsBefore)
    assert.equal(calls.some(([kind]) => kind === 'ready'), false)
  }, { confinementPlanner: () => {
    const tier = ++plans === 1 ? 'standard' : 'unrestricted'
    return { ok: true, tier, isolated: true, threadOptions: {
      sandbox: tier === 'standard' ? 'workspace-write' : 'danger-full-access', approvalPolicy: 'never',
    }, env: {}, servers: [] }
  } })
})

test('retiring a successful start permit does not re-authorize or break subsequent turns', async t => {
  await fixture(t, async ({ host }) => {
    let cancelled = false
    let assertions = 0
    const permit = {
      assertStart() { assertions++; if (cancelled) throw refusal() },
      cancel() { cancelled = true },
    }
    await host.startSession({ ...request(), delegationPermit: permit })
    assert.equal(assertions, 2)
    permit.cancel()
    await host.sendTurn({ sessionId: 'scope-parent', text: 'Perform the next bounded task.', origin: 'user' })
    assert.equal(assertions, 2, 'the start-only permit must not be consulted for a turn on the existing root')
    assert.equal(host.readTreeParent('scope-parent').sessionId, 'scope-parent')
  })
})
