// The blank role is a saved choice, distinct from its required transport seat.
// Drive the actual renderer binding, IPC parser, installed Engine role stores,
// and real app host. Only the provider protocol and credential issuer are fixtures.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createFleetTreeStore, safeTreeStorage } from '../../src/fleet-trees.js'
import { identityRoleForTreeNode } from '../../src/tree-node-identity.js'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENGINE_ROOT = canonicalRootForTests({ requireConfigured: true })
const record = require('../../shell/agent-org-record.cjs')
const { createAgentHost } = require('../../shell/agent-host.cjs')
const ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const protocol = require(ENGINE)
const MAIN = readFileSync(path.join(ROOT, 'shell/main.cjs'), 'utf8')
const VIEW = readFileSync(path.join(ROOT, 'src/views/computers.js'), 'utf8')
const parseContext = vm.createContext({ MAX_SESSION_ID_LENGTH: 128, MAX_SURFACE_LENGTH: 64 })
for (const name of ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentStart']) {
  vm.runInContext(declaredFunctionSource(MAIN, name), parseContext)
}
const parse = value => JSON.parse(JSON.stringify(parseContext.parseAgentStart(value)))
const treeIdentity = { selfName: 'Assistant', managerName: null }

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'blank-tree-role-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const modules = record.loadModules({ root: ENGINE_ROOT })
  assert.equal(modules.ok, true, modules.reason)
  const makeRecord = () => record.createAgentOrgRecord({ modules, env: { LOCALAPPDATA: directory,
    TOOLSENABLED_STATE_ROOT: path.join(directory, 'Blank role fixture', 'capability') } })
  const api = makeRecord()
  const storage = new Map()
  const storeOptions = { computerId: 'role-choice', storage: safeTreeStorage({
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  }) }
  const store = createFleetTreeStore(storeOptions)
  function bindingFor(selection) {
    const node = store.addNode({ role: selection, message: 'Keep the requested task.', tier: 'luna' }).node
    const roleId = identityRoleForTreeNode(node.role)
    const written = api.ensureSeat({ id: node.id, role: roleId, provider: 'codex', nodeId: node.id,
      ...(roleId === 'worker' ? { roleSelection: selection } : {}) })
    assert.equal(written.ok, true, written.reason)
    const snapshot = makeRecord().read()
    assert.equal(snapshot.ok, true, snapshot.reason)
    const context = vm.createContext({ orgReady: () => true, orgAvailability: snapshot,
      roleRecordFor: id => snapshot.roles.find(role => role.id === id), rootSeatFor: () => null })
    vm.runInContext(declaredFunctionSource(VIEW, 'roleBindingForStart'), context)
    const restored = createFleetTreeStore(storeOptions).getNode(node.id)
    assert.equal(restored.role, selection, 'saving/reloading the node must preserve the actual role choice')
    const selected = context.roleBindingForStart(node.id, roleId, restored.role)
    assert.equal(selected.ok, true, selected.message)
    return { node: restored, binding: JSON.parse(JSON.stringify(selected.binding)), snapshot }
  }
  return { directory, api, makeRecord, bindingFor }
}

test('blank selection survives saved-node binding, IPC parsing and fresh authoritative resolution', t => {
  const f = fixture(t)
  for (const selection of ['', 'worker', 'manager']) {
    const { binding, node } = f.bindingFor(selection)
    assert.equal(binding.id, selection || 'worker')
    assert.equal(binding.agentId, node.id)
    assert.equal(Object.hasOwn(binding, 'selection'), selection === '')
    if (selection === '') assert.equal(binding.selection, '')
    const request = parse({ sessionId: 'selection-start', treeIdentity, roleBinding: binding })
    assert.deepEqual(request.roleBinding, binding)
    const resolved = f.makeRecord().resolveRoleBinding(request.roleBinding)
    assert.equal(resolved.ok, true, resolved.reason)
    assert.equal(resolved.roleSelection, selection === '' ? '' : undefined)
    assert.equal(resolved.authority.roleId, selection || 'worker')
    assert.equal(resolved.authority.agentId, node.id)
    assert.equal(f.makeRecord().read().org.agents.find(agent => agent.id === node.id).roleSelection, selection === '' ? '' : undefined)
    assert.ok(resolved.role.owns.length > 0, 'the authoritative role remains available to enforce the seat')
    const { createContinuationState } = require(path.join(ENGINE_ROOT, 'src/lib/agent-continuation-state.js'))
    const continuationFile = path.join(f.directory, `continuation-${selection || 'blank'}.sqlite`)
    let continuation = createContinuationState({ file: continuationFile })
    let durable
    try {
      const row = continuation.track({ ...request, resumeThreadId: 'saved-thread', resumeThreadProvider: 'codex' })
      continuation.close()
      continuation = createContinuationState({ file: continuationFile })
      durable = continuation.get(row.key).descriptor
    } finally { continuation.close() }
    assert.deepEqual(durable.roleBinding, binding, 'actual continuation storage must preserve the full role choice across restart')
    const resumed = parse({ sessionId: 'selection-resume', treeIdentity: durable.treeIdentity, roleBinding: durable.roleBinding,
      resumeThreadId: durable.resumeThreadId, resumeThreadProvider: durable.resumeThreadProvider })
    assert.deepEqual(resumed.roleBinding, binding, 'resume coercion must not turn an empty choice into assigned Worker')
    assert.equal(f.makeRecord().resolveRoleBinding(resumed.roleBinding).roleSelection, resolved.roleSelection)
  }
})

test('the actual seat preparation migrates an older blank node and clears the marker when Worker is selected', async t => {
  const f = fixture(t), original = f.bindingFor('worker'), calls = []
  const node = { ...original.node, role: '' }
  const context = vm.createContext({ orgReady: () => true, orgAvailability: f.makeRecord().read(),
    roleRecordFor: id => original.snapshot.roles.find(role => role.id === id), rootSeatFor: () => null,
    treeNodeName: () => 'Assistant', LAUNCH_TIERS: [{ id: 'luna', provider: 'codex' }],
    window: { mcOrg: { ensureSeat(request) { calls.push(JSON.parse(JSON.stringify(request))); return f.api.ensureSeat(calls.at(-1)) } } },
    isRevisionConflict: () => false,
  })
  vm.runInContext(declaredFunctionSource(VIEW, 'ensureSeatForNode'), context)
  assert.equal((await context.ensureSeatForNode(node, 'worker')).ok, true)
  assert.equal(calls.length, 1, 'the old matching Worker identity must not bypass saving the real empty choice')
  assert.equal(calls[0].roleSelection, '')
  assert.equal(f.makeRecord().read().org.agents.find(agent => agent.id === node.id).roleSelection, '')
  assert.equal((await context.ensureSeatForNode(node, 'worker')).unchanged, true)
  assert.equal(calls.length, 1)
  assert.equal((await context.ensureSeatForNode({ ...node, role: 'worker' }, 'worker')).ok, true)
  assert.equal(calls.length, 2)
  assert.equal(f.makeRecord().read().org.agents.find(agent => agent.id === node.id).roleSelection, undefined)
})

test('empty selection cannot erase another assigned role or create an anonymous identity', t => {
  const f = fixture(t)
  const manager = f.bindingFor('manager').binding
  const worker = f.bindingFor('worker').binding
  for (const binding of [
    { ...manager, selection: '' },
    ...[null, false, 'worker', ''].map(selection => ({ ...worker, agentId: undefined, selection })),
    ...[null, false, 'worker'].map(selection => ({ ...worker, selection })),
  ]) {
    const packet = JSON.parse(JSON.stringify(binding))
    assert.throws(() => parse({ sessionId: 'forged', treeIdentity, roleBinding: packet }), error => error.code === 'MC_AGENT_ROLE_BINDING_INVALID')
    assert.equal(f.makeRecord().resolveRoleBinding(packet).ok, false)
  }
  assert.throws(() => parse({ sessionId: 'not-tree', roleBinding: { ...worker, selection: '' } }),
    error => error.code === 'MC_AGENT_ROLE_BINDING_INVALID')
  const forged = parse({ sessionId: 'forged-worker-choice', treeIdentity, roleBinding: { ...worker, selection: '' } })
  assert.equal(f.makeRecord().resolveRoleBinding(forged.roleBinding).code, 'MC_AGENT_ROLE_STALE',
    'a caller cannot erase assigned Worker directions without changing the saved choice')
  const blank = f.bindingFor('').binding
  delete blank.selection
  assert.equal(f.makeRecord().resolveRoleBinding(blank).code, 'MC_AGENT_ROLE_STALE',
    'an old caller must not silently turn a saved blank choice into Worker')
})

for (const selection of ['', 'worker']) {
  test(`${selection || 'blank'} role keeps its first, later and resumed provider prompts and exact identity`, async t => {
    const f = fixture(t)
    const { binding } = f.bindingFor(selection)
    // Round-trip the same durable descriptor that replacement/account paths
    // retain. The full authority is resolved afresh for each host start.
    const savedBinding = JSON.parse(JSON.stringify(binding))
    const bindings = [], revoked = []
    const issued = Buffer.alloc(32, 53).toString('base64url')
    const host = createAgentHost({ enginePath: ENGINE, defaultCwd: f.directory,
      freeMemory: () => 64 * 1024 ** 3,
      confinementPlanner: () => ({ ok: true, tier: 'guided', isolated: true,
        threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {}, servers: [] }),
      sessionAuthority: {
        bind: value => { bindings.push(value); return { bound: true, credential: issued } },
        revoke: value => { revoked.push(value); return { revoked: true } },
      },
    })
    t.after(() => host.closeAll())
    for (const resume of [false, true]) {
      const parsed = parse({ sessionId: resume ? 'resumed' : 'fresh', treeIdentity, roleBinding: savedBinding,
        ...(resume ? { resumeThreadId: 'saved-thread', resumeThreadProvider: 'codex' } : {}) })
      const resolved = f.makeRecord().resolveRoleBinding(parsed.roleBinding)
      assert.equal(resolved.ok, true, resolved.reason)
      const { roleBinding, ...request } = parsed
      const started = await host.startSession({ ...request, role: resolved.role, roleSelection: resolved.roleSelection,
        agentId: resolved.agent.id, agentAuthority: resolved.authority })
      assert.equal(Boolean(started.roleIntroduction), selection !== '')
      for (const turn of ['first', 'later']) {
        const accepted = await host.sendTurn({ sessionId: request.sessionId, text: `${turn} exact task` })
        const actual = protocol.adapterCalls.at(-1).request.text
        assert.ok(actual.startsWith(`${turn} exact task`))
        const roleAdded = accepted.transcriptPrompt.additions.find(part => part.kind === 'role')
        assert.equal(Boolean(roleAdded), selection !== '' && turn === 'first')
        if (selection === '') assert.doesNotMatch(actual, /TOOLSENABLED ROLE DIRECTIONS|Role: Worker|focused assignment context/)
        else if (turn === 'first') assert.ok(actual.endsWith(started.roleIntroduction))
        protocol.calls.at(-1).onEvent({ type: 'turn_completed', threadId: started.threadId, turnId: 't1', status: 'completed' })
      }
      await host.closeSession({ sessionId: request.sessionId })
    }
    assert.equal(bindings.length, 2)
    assert.equal(revoked.length, 2)
    for (const bound of bindings) {
      assert.equal(bound.agentId, savedBinding.agentId)
      assert.equal(bound.roleId, 'worker')
      assert.equal(bound.expectedOrgRevision, savedBinding.expectedOrgRevision)
      assert.equal(bound.expectedRoleRevision, savedBinding.expectedRoleRevision)
    }
  })
}

test('an assigned custom role with empty text keeps its persisted identity and policy through App resolution and composition', t => {
  const f = fixture(t), id = 'empty-custom-helper', rules = { owns: '', mustNot: '', handoff: '' }
  const created = f.api.createRole({ id, baseDefaultRole: null, rules, functions: ['app.context'], requiresDirectUserAuthorization: true })
  assert.equal(created.ok, true, created.reason)
  const declared = f.api.ensureSeat({ id: 'custom-node', nodeId: 'custom-node', role: id, provider: 'codex' })
  assert.equal(declared.ok, true, declared.reason)
  const snapshot = f.makeRecord().read(), stored = snapshot.roles.find(role => role.id === id)
  assert.deepEqual(Object.fromEntries(Object.keys(rules).map(key => [key, stored[key]])), rules)
  const parsed = parse({ sessionId: 'empty-custom', treeIdentity, roleBinding: { agentId: 'custom-node', id,
    expectedOrgRevision: snapshot.org.revision, expectedRoleRevision: stored.revision } })
  const resolved = f.makeRecord().resolveRoleBinding(parsed.roleBinding)
  assert.equal(resolved.ok, true, resolved.reason)
  assert.equal(resolved.roleSelection, undefined, 'an assigned empty-text role remains an actual selected role')
  assert.equal(resolved.authority.roleId, id)
  assert.deepEqual(resolved.role.capabilities, stored.capabilities)
  const introduction = require('../../shell/agent-host.cjs').composeRoleIntroduction(resolved.role)
  assert.match(introduction, /Role: empty-custom-helper/)
  assert.match(introduction, /Selected functions \(1\): app.context/)
  assert.match(introduction, /act only on a direct request from the person/)
  assert.doesNotMatch(introduction, /Owns:|Must not:|Hands off to:|Worker|Not written yet/)
})
