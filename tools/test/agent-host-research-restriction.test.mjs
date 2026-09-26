import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createAgentHost } from '../../shell/agent-host.cjs'

const require = createRequire(import.meta.url)
const ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const engine = require(ENGINE)
const directory = require('./fixtures/confined-engine/src/lib/agent-comms/tree-node-directory.js')
const { rootLifecycle, control } = require('./fixtures/dual-engine/root-lifecycle.cjs')
const ISSUED = Buffer.alloc(32, 0x54).toString('base64url')
const permission = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' })
const flush = () => new Promise(resolve => setImmediate(resolve))

function makePermit(root, hooks = {}) {
  const researchAccess = Object.freeze({ version: 1, mode: 'clean-room', root, access: 'read-only' })
  return { researchAccess, details: { parentSessionId: 'parent-session', nodeId: 'child-node', mode: 'clean-room', access: 'read-only' },
    assertStart: hooks.assertStart || (() => {}), cancel: hooks.cancel || (() => {}) }
}

function hostFixture(t, authority, planner = () => ({ ok: true, tier: 'standard', isolated: true, agentApiMode: 'Only', roleFunctionsOnly: true, threadOptions: {}, env: {}, servers: [] }), observeProvider = null, wrapEngine = true) {
  const workdir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'te-research-host-')))
  const previousMarker = engine.ROOT_ADMISSION_CONTRACT_VERSION
  engine.ROOT_ADMISSION_CONTRACT_VERSION = 1
  const originalStart = engine.startCodexSession
  if (wrapEngine) {
    t.mock.method(engine, 'startCodexSession', async options => {
      if (observeProvider) observeProvider(options)
      const lifecycle = await rootLifecycle(options.rootLaunch)
      const result = await originalStart(options)
      return { ...result, close() { result.close(); lifecycle.close() } }
    })
  }
  directory.reset()
  const governor = {
    reserve() { return { ok: true, token: 'fixture-reservation', state: { mode: 'off' } } },
    revalidate() { return { ok: true } },
    ready() {},
    release() {},
  }
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: workdir, profileRoot: path.parse(workdir).root,
    freeMemory: () => 64 * 1024 ** 3, resourceGovernor: governor, confinementPlanner: planner,
    sessionAuthority: authority, startProviderProbe: () => 'codex' })
  t.after(async () => {
    await host.closeAll()
    control.prepare = null
    directory.reset()
    if (previousMarker === undefined) delete engine.ROOT_ADMISSION_CONTRACT_VERSION
    else engine.ROOT_ADMISSION_CONTRACT_VERSION = previousMarker
    rmSync(workdir, { recursive: true, force: true })
  })
  return { host, workdir }
}

function request(root, researchPermit, extra = {}) {
  return { sessionId: 'restricted-child', agentId: 'child-agent', role: { id: 'worker', name: 'Worker', owns: 'Restricted research', mustNot: 'Widen folder scope', handoff: 'Parent' }, roleSelection: '', agentAuthority: { agentId: 'child-agent', provider: 'codex', roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 }, research: { mode: 'clean-room', access: 'read-only', prompt: 'read explicit files only' },
    researchPermit, cwd: path.dirname(root), treeIdentity: { selfName: 'Child', managerName: 'Parent' },
    requestKeys: { treeAnchors: ['tree-root', 'child-agent'], threadId: 'child-agent' }, ...extra }
}

test('restricted research refuses without owner-host version and native-only enforcement', async t => {
  for (const authority of [
    { scopeVersion: 1, toolModeVersion: 1, bind: () => ({ bound: false }), revoke() {} },
    { scopeVersion: 1, toolModeVersion: 1, researchAccessVersion: 1, bind: () => ({ bound: true, credential: ISSUED }), revoke() {} },
  ]) {
    const { host, workdir } = hostFixture(t, authority, () => ({ ok: true, tier: 'standard', isolated: true, threadOptions: {}, env: {}, servers: [] }), null, false)
    const refused = await Promise.resolve().then(() => host.startSession(request(workdir, makePermit(workdir)))).then(() => null, error => error)
    assert.ok(refused)
    assert.ok(['AGENT_RESEARCH_SCOPE_UNAVAILABLE', 'AGENT_RESEARCH_TOOL_RESTRICTION_UNAVAILABLE'].includes(refused.code), refused.code)
    await host.closeAll()
  }
})

test('trusted permit binds the real fixture root, registers identity, and exposes scope after send', async t => {
  const binds = []
  let providerOptions = null
  const authority = { scopeVersion: 1, toolModeVersion: 1, researchAccessVersion: 1,
    assert() { return { valid: true } },
    bind: (principal, scope) => { binds.push({ principal, scope }); return { bound: true, credential: ISSUED } },
    readScope: () => ({ permissionSession: permission, workspaceRoots: [binds[0]?.scope.researchAccess.root], researchAccess: binds[0]?.scope.researchAccess }),
    revoke() {} }
  const { host, workdir } = hostFixture(t, authority, undefined, options => { providerOptions = options })
  const trusted = makePermit(workdir)
  const result = await host.startSession(request(workdir, trusted, { research: undefined, sessionId: 'restricted-root' }))
  assert.equal(providerOptions.cwd, workdir)
  assert.equal(binds[0].principal.agentId, 'child-agent')
  assert.deepEqual(binds[0].scope.researchAccess, trusted.researchAccess)
  assert.equal(result.researchRestriction.root, workdir)
  const beforeFirstTurn = host.readTreeParent(result.sessionId)
  assert.deepEqual(beforeFirstTurn.researchAccess, trusted.researchAccess)
  assert.equal(beforeFirstTurn.nodeId, 'child-agent', 'main must verify the node before any prompt is sent')
  await host.sendTurn({ sessionId: result.sessionId, text: 'inspect the explicit files' })
  await flush()
  await flush()
  const parent = host.readTreeParent(result.sessionId)
  assert.deepEqual(parent.researchAccess, trusted.researchAccess)
  assert.equal(parent.selfName, 'Child')
  await host.closeAll()
})

test('permit cancellation after awaited bind prevents provider start', async t => {
  let starts = 0
  let resolveBind
  const binding = new Promise(resolve => { resolveBind = resolve })
  let revoked = false
  const permit = { assertStart() { if (revoked) throw Object.assign(new Error('cancelled'), { code: 'AGENT_SESSION_START_CANCELLED' }) }, cancel() { revoked = true } }
  t.mock.method(engine, 'startCodexSession', async () => { starts += 1; return { threadId: 'late', adapter: { sendTurn: async () => ({ turnId: 'turn-1' }), interrupt() {}, answerApproval() {} }, close() {} } })
  const authority = { scopeVersion: 1, toolModeVersion: 1, researchAccessVersion: 1,
    bind: async () => binding, revoke() {} }
  const { host, workdir } = hostFixture(t, authority)
  const started = host.startSession(request(workdir, Object.assign(permit, { researchAccess: Object.freeze({ version: 1, mode: 'clean-room', root: workdir, access: 'read-only' }), details: { parentSessionId: 'parent-session', nodeId: 'child-node' } }), { sessionId: 'cancelled-research' }))
  await flush()
  permit.cancel()
  resolveBind({ bound: true, credential: ISSUED })
  const refused = await started.then(() => null, error => error)
  assert.equal(refused.code, 'AGENT_SESSION_START_CANCELLED')
  assert.equal(starts, 0)
  await host.closeAll()
})
