import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { createAgentHost } from '../../shell/agent-host.cjs'
const require = createRequire(import.meta.url)
const enginePath = path.resolve(import.meta.dirname, 'fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
const claude = require('./fixtures/dual-engine/src/lib/agent-engine/claude-cli-process.js')
const { control } = require('./fixtures/dual-engine/root-lifecycle.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const settled = promise => promise.then(value => ({ value }), error => ({ error }))
async function until(predicate) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await delay(5) }
  assert.fail('bounded host fixture did not settle')
}

async function fixture(t, { duration = 30, ...overrides } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'te-bounded-host-'))
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {}, servers: [] })
  let valid = true, checks = 0, releases = 0
  const expires = performance.now() + duration
  const permit = { details: { action: 'tree.dispatch', sessionId: 'bounded', agentId: null, capMs: duration },
    assertStart() { checks++; if (!valid) throw Object.assign(new Error('changed'), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' }) },
    remainingMs: () => Math.max(0, expires - performance.now()), cancel() { valid = false } }
  const host = createAgentHost({ enginePath, defaultCwd: workdir, startProviderProbe: () => 'claude',
    providerCommandResolver: () => path.join(workdir, 'never-executed-fixture-claude.exe'),
    resourceGovernor: { reserve: () => ({ ok: true, token: 'reservation', state: { mode: 'off' } }),
      revalidate: () => ({ ok: true }), ready() {}, release() { releases++ } },
    sessionAuthority: { bind: () => ({ bound: false, mode: 'in-process', credential: null }), revoke() {}, assert: () => ({ valid: true }) },
    ...overrides,
  })
  t.after(async () => {
    control.prepare = null
    await host.closeAll()
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN; else process.env.MC_TEST_CONFINEMENT_PLAN = previous
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') console.log('RETAINED_BOUNDED_WORK_FIXTURE ' + workdir)
    else rmSync(workdir, { recursive: true, force: true })
  })
  return { host, permit, invalidate: () => { valid = false }, checks: () => checks, releases: () => releases }
}

test('host-owned cap closes the retained scope after every view listener leaves', async t => {
  const f = await fixture(t)
  const remove = f.host.onEvent(() => {})
  const result = await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit })
  assert.equal(result.boundedWork.state, 'ready')
  assert.ok(f.checks() >= 3, 'the private parent guard must also run at the actual provider root')
  remove()
  await until(() => f.host.boundedWorkStatus('bounded')?.state === 'closed')
  assert.equal(f.host.boundedWorkStatus('bounded').reason, 'cap-reached')
  assert.equal(f.releases(), 1)
  await assert.rejects(f.host.sendTurn({ sessionId: 'bounded', text: 'late work' }), { code: 'AGENT_SESSION_UNKNOWN' })
})

test('cap completion is emitted only after retained cleanup has actually resolved', async t => {
  const finish = Promise.withResolvers()
  let entered = false
  const original = claude.startClaudeSession
  t.mock.method(claude, 'startClaudeSession', async options => {
    const started = await original(options)
    const close = started.close
    started.close = async () => { entered = true; await finish.promise; close() }
    return started
  })
  const f = await fixture(t), packets = []
  f.host.onEvent(packet => packets.push(packet))
  try {
    await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit })
    await until(() => entered)
    assert.equal(f.host.boundedWorkStatus('bounded').state, 'closing')
    assert.equal(packets.filter(packet => packet.event.type === 'session_ended').length, 0)
    assert.equal(f.releases(), 0)
    finish.resolve()
    await until(() => f.host.boundedWorkStatus('bounded').state === 'closed')
    assert.deepEqual(packets.filter(packet => packet.event.type === 'session_ended').map(packet => packet.event.reason), ['cap-reached'])
    assert.equal(f.releases(), 1)
  } finally { finish.resolve() }
})

test('manual Stop disarms the cap and cannot close or debit the same scope twice', async t => {
  const f = await fixture(t)
  await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit })
  await f.host.closeSession({ sessionId: 'bounded' })
  await delay(50)
  assert.equal(f.host.boundedWorkStatus('bounded').reason, 'closed')
  assert.equal(f.releases(), 1)
})

test('parent drift during root preparation refuses before the fixture root executes', async t => {
  const f = await fixture(t), roots = control.roots
  control.prepare = () => { f.invalidate() }
  await assert.rejects(f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit }), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
  assert.equal(control.roots, roots)
  assert.equal(f.releases(), 1)
  assert.equal(f.host.boundedWorkStatus('bounded').reason, 'start-refused')
})

test('an expired cap cancels a still-pending account selection without starting a late root', async t => {
  const account = Promise.withResolvers()
  const f = await fixture(t, { accountResolver: () => account.promise }), roots = control.roots
  const started = settled(f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit }))
  await until(() => f.host.boundedWorkStatus('bounded')?.state === 'closing')
  account.resolve(null)
  assert.equal((await started).error?.code, 'MC_TREE_BOUNDED_WORK_CAP_REACHED')
  assert.equal(control.roots, roots)
  assert.equal(f.releases(), 1)
})

const parentTree = { requestKeys: { treeAnchors: ['parent-node'], threadId: 'parent-node' }, treeIdentity: { selfName: 'Parent', managerName: null } }
const childTree = { requestKeys: { treeAnchors: ['parent-node', 'child-node'], threadId: 'child-node' }, treeIdentity: { selfName: 'Child', managerName: 'Parent' } }

test('a nested provider root inherits the remaining cap without a renderer cap claim', async t => {
  const f = await fixture(t, { duration: 150 })
  await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit, ...parentTree })
  await delay(30)
  const result = await f.host.startSession({ sessionId: 'nested', ...childTree })
  assert.equal(result.boundedWork.action, 'tree.delegate')
  assert.equal(result.boundedWork.parentSessionId, 'bounded')
  assert.ok(result.boundedWork.capMs < 140, 'delegation must not reset the original allowance')
  await until(() => f.host.boundedWorkStatus('bounded').state === 'closed')
  assert.equal(f.host.boundedWorkStatus('nested').state, 'closed')
  assert.equal(f.host.boundedWorkStatus('nested').reason, 'cap-reached')
  assert.equal(f.releases(), 2)
})

test('parent Stop closes independently launched nested roots before returning', async t => {
  const f = await fixture(t, { duration: 10000 })
  const ended = []
  f.host.onEvent(packet => { if (packet.event.type === 'session_ended') ended.push(packet) })
  await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit, ...parentTree })
  await f.host.startSession({ sessionId: 'nested', ...childTree })
  await f.host.closeSession({ sessionId: 'bounded' })
  assert.equal(f.host.boundedWorkStatus('nested').state, 'closed')
  assert.equal(f.host.boundedWorkStatus('nested').reason, 'parent-stopped')
  assert.deepEqual(ended.map(packet => [packet.sessionId, packet.event.reason]), [['nested', 'parent-stopped']])
  assert.equal(f.releases(), 2)
  await assert.rejects(f.host.sendTurn({ sessionId: 'nested', text: 'after parent Stop' }), { code: 'AGENT_SESSION_UNKNOWN' })
})

test('a failed nested cleanup retains both host handles and the parent debit until retry proves closure', async t => {
  const original = claude.startClaudeSession
  let starts = 0, refuse = true
  t.mock.method(claude, 'startClaudeSession', async options => {
    const started = await original(options), close = started.close
    if (++starts === 2) started.close = async () => {
      if (refuse) throw Object.assign(new Error('fixture cleanup pending'), { code: 'FIXTURE_CLEANUP_PENDING' })
      return close()
    }
    return started
  })
  const f = await fixture(t, { duration: 10000 })
  await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit, ...parentTree })
  await f.host.startSession({ sessionId: 'nested', ...childTree })
  await assert.rejects(f.host.closeSession({ sessionId: 'bounded' }))
  assert.equal(f.host.boundedWorkStatus('bounded').state, 'close-failed')
  assert.equal(f.host.boundedWorkStatus('nested').state, 'close-failed')
  assert.equal(f.releases(), 0)
  refuse = false
  await f.host.closeSession({ sessionId: 'bounded' })
  assert.equal(f.host.boundedWorkStatus('nested').state, 'closed')
  assert.equal(f.releases(), 2)
})

test('private delegated admission expires if its exact parent closes before the signed start reaches the host', async t => {
  const f = await fixture(t, { duration: 10000 })
  await f.host.startSession({ sessionId: 'bounded', boundedWorkPermit: f.permit, ...parentTree })
  const request = { sessionId: 'nested', ...childTree }
  const permit = f.host.inheritBoundedWork(request)
  const roots = control.roots
  await f.host.closeSession({ sessionId: 'bounded' })
  await assert.rejects(async () => f.host.startSession({ ...request, boundedWorkPermit: permit }), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
  assert.equal(control.roots, roots)
})
