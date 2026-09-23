import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
const require = createRequire(import.meta.url)
const engineRoot = ownedFixtureTempRoot({ selected: canonicalRootForTests() })
const engine = createRequire(path.join(engineRoot, 'package.json'))
const temp = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'te-tool-settings-'))
engine('./tests/lib/isolated-environment.js').configure(temp)
const api = require('../../shell/product-settings.cjs')
const settings = engine('./src/lib/settings.js')
const valuesPath = settings.resolveValuesPath({})
const options = { root: engineRoot, owner: 19 }
const registry = engine('./src/lib/settings-registry.js').loadRegistry()
const mode = engine('./src/lib/tool-mode.js')
const apiPolicy = engine('./src/lib/agent-api-policy.js')
const purchase = engine('./src/lib/purchase-authority.js')
function seed(values = {}) {
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true })
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user', atMs: 1, directive: null }])) }))
}
function set(id, value, extra = {}) { return api.setProductSetting({ id, value, ...extra }, options) }
function saved() { return settings.loadSettings() }
function confirmOff() {
  const challenge = api.beginProductSettingConfirmation({ id: 'purchases.require_owner_approval', value: false }, options)
  assert.equal(challenge.ok, true)
  return { confirmationId: challenge.confirmationId, code: challenge.code }
}
test.after(async () => {
  await engine('./src/lib/audit-admission.js').defaultAdmissionQueue().flush()
  await engine('./src/lib/audit-admission.js').defaultAdmissionQueue().close()
  engine('./src/lib/audit-admission.js').resetAdmissionQueueForTests()
  engine('./src/lib/audit.js').resetForTests()
  await engine('./src/lib/vault-host-client.js').closeVaultHost()
  engine('./src/lib/state-store.js').closeStateStore()
  fs.rmSync(temp, { recursive: true, force: true })
})

test('legacy permissive tools and purchase choices survive a read without mutating any bytes', () => {
  seed({ 'agent.agent_api': false, 'outward.reserved_from_agents': ['Posting to social media'] })
  const before = fs.readFileSync(valuesPath)
  const rows = api.readProductSettings(options).rows
  assert.equal(rows.find(row => row.id === 'agent.agent_api').value, 'Enabled')
  assert.equal(rows.find(row => row.id === 'purchases.require_owner_approval').value, false)
  assert.equal(rows.some(row => row.id === 'agent.tool_mode'), false)
  assert.equal(purchase.purchaseApprovalReserved().reserved, false)
  assert.deepEqual(fs.readFileSync(valuesPath), before)
})

test('all three modes write through the real shell, generator, Claude argv and Codex config', () => {
  seed()
  const machine = engine('./src/lib/setup/machine-record.js')
  const record = machine.buildMachineRecord({ tier: 'unrestricted', installRoot: engineRoot,
    servicesRoot: path.dirname(valuesPath), nodePath: process.execPath, workspaceRoots: [temp] })
  for (const choice of mode.MODES) {
    assert.equal(set('agent.tool_mode', choice).ok, true)
    assert.equal(mode.toolMode(), choice)
    const generated = machine.generateMcpConfig(record)
    if (choice === mode.MODE.NATIVE) assert.deepEqual(generated.document.mcpServers, {})
    else assert.ok(Object.keys(generated.document.mcpServers).length >= 2)
    assert.deepEqual(apiPolicy.agentApiArgs(), choice === mode.MODE.ONLY ? ['--tools', '', '--setting-sources', '', '--disable-slash-commands'] : [])
    const config = engine('./src/lib/agent-session-confinement.js').confinedCodexConfig({ tier: 'unrestricted', sandbox: 'danger-full-access', approvalPolicy: 'never' }, { mcpServers: {} }, machine, null, choice === mode.MODE.ONLY)
    assert.equal(config.includes('shell_tool = false'), choice === mode.MODE.ONLY)
    assert.equal(config.includes("sandbox_mode = 'read-only'"), choice === mode.MODE.ONLY)
  }
  assert.equal(set('agent.agent_api', false).ok, true)
  assert.equal(mode.toolMode(), mode.MODE.BOTH)
})

test('numeric metadata matches validation; refusals roll back exact bytes', () => {
  for (const id of ['tools.audit_batch_window_ms', 'tools.audit_batch_size', 'tools.credential_check_interval_seconds', 'model.local_context_tokens', 'model.local_keep_alive_minutes', 'fleet.max_declared_agents']) {
    const row = api.readProductSettings(options).rows.find(row => row.id === id)
    assert.equal(row.min, registry.byId.get(id).minimum)
    assert.equal(row.max, registry.byId.get(id).maximum)
    for (const value of [row.min, row.max]) assert.equal(set(id, value).ok, true)
    const before = fs.readFileSync(valuesPath)
    for (const value of [row.min - 1, row.max + 1, row.min + 0.5, '3', null]) {
      assert.equal(set(id, value).ok, false)
      assert.deepEqual(fs.readFileSync(valuesPath), before)
    }
  }
})

test('service addresses reject malformed URLs before they can remain saved', () => {
  for (const address of ['http://127.0.0.1:11434', 'https://example.invalid/v1']) assert.equal(set('model.endpoint', address).ok, true)
  const before = fs.readFileSync(valuesPath)
  for (const address of ['localhost:11434', 'not a url', 'file:///tmp/model', 'https://user:password@example.invalid', 'https://example.invalid/?token=x', 'https://example.invalid/#fragment']) {
    assert.equal(set('model.endpoint', address).ok, false)
    assert.deepEqual(fs.readFileSync(valuesPath), before)
  }
})

// The launcher writes the starting mode of a session into its environment.
// Whatever session runs this suite has one of its own, so each case below
// states the ambient binding it means to exercise instead of inheriting it.
// agent-session-confinement.js and setup/machine-record.js spell this name
// at the launcher; tool-mode.js reads it. There is no exported constant.
const LAUNCH_MODE_VARIABLE = 'TOOLSENABLED_AGENT_TOOL_MODE'
async function withLaunchedMode(value, body) {
  const had = Object.hasOwn(process.env, LAUNCH_MODE_VARIABLE)
  const previous = process.env[LAUNCH_MODE_VARIABLE]
  if (value === undefined) delete process.env[LAUNCH_MODE_VARIABLE]
  else process.env[LAUNCH_MODE_VARIABLE] = value
  try { await body() }
  finally {
    if (had) process.env[LAUNCH_MODE_VARIABLE] = previous
    else delete process.env[LAUNCH_MODE_VARIABLE]
  }
}

test('Native tools only refuses real API dispatch and session bindings survive later setting changes', async () => {
  seed({ 'agent.tool_mode': mode.MODE.NATIVE })
  const tools = engine('./src/lib/tool-registry.js')
  // No session binding at all: the saved choice is what dispatch must read.
  await withLaunchedMode(undefined, async () => {
    await assert.rejects(tools.executeTool('settings.read', {}, { permissionSession: { origin: 'local', tier: 'full' } }), { code: 'TOOL_API_DISABLED' })
  })
  // A bound API-enabled session retains its start-time choice. Omit its
  // permission session so dispatch stops at the next independent boundary.
  await assert.rejects(tools.executeTool('settings.read', {}, { toolMode: mode.MODE.BOTH }), { code: 'PERMISSION_SESSION_REQUIRED' })
  set('agent.tool_mode', mode.MODE.BOTH)
  await assert.rejects(tools.executeTool('settings.read', {}, { toolMode: mode.MODE.NATIVE, permissionSession: { origin: 'local', tier: 'full' } }), { code: 'TOOL_API_DISABLED' })
  // A session launched into Native tools only keeps refusing after the saved
  // choice moves the other way; the launch binding outranks the later write.
  await withLaunchedMode(mode.MODE.NATIVE, async () => {
    await assert.rejects(tools.executeTool('settings.read', {}, { permissionSession: { origin: 'local', tier: 'full' } }), { code: 'TOOL_API_DISABLED' })
  })
})

test('purchase OFF requires the exact current one-use local code and preserves other reservations', () => {
  seed({ 'outward.reserved_from_agents': ['Posting to social media', purchase.RESERVATION_PURCHASES] })
  assert.equal(set('purchases.require_owner_approval', false).code, 'SETTING_CONFIRMATION_REQUIRED')
  const stale = confirmOff()
  assert.equal(set('tools.audit_batch_size', 16).ok, true)
  assert.equal(set('purchases.require_owner_approval', false, { confirmation: stale }).code, 'SETTING_CONFIRMATION_REQUIRED')
  const wrongOwner = confirmOff()
  assert.equal(api.setProductSetting({ id: 'purchases.require_owner_approval', value: false, confirmation: wrongOwner }, { ...options, owner: 20 }).ok, false)
  const expired = confirmOff()
  const clock = Date.now
  try { Date.now = () => clock() + 120001; assert.equal(set('purchases.require_owner_approval', false, { confirmation: expired }).ok, false) }
  finally { Date.now = clock }
  const good = confirmOff()
  assert.equal(set('purchases.require_owner_approval', false, { confirmation: good }).ok, true)
  assert.deepEqual(saved().values['outward.reserved_from_agents'], ['Posting to social media'])
  assert.equal(purchase.authorizeSpend({ amountCents: 100, currency: 'USD' }).authorized, true)
  assert.equal(set('purchases.require_owner_approval', false, { confirmation: good }).ok, false)
  assert.equal(set('purchases.require_owner_approval', true).ok, true)
  assert.equal(purchase.authorizeSpend({ amountCents: 100, currency: 'USD' }).authorized, false)
})

test('P13 default, user write, launcher pin and real registry refusal agree', async () => {
  seed()
  delete process.env.TOOLSENABLED_P13_POLICY_ENFORCE
  const tools = engine('./src/lib/tool-registry.js')
  assert.equal(tools.p13PolicyEnforcementEnabled(), false)
  assert.equal(set('tools.policy_enforcement', true).ok, true)
  assert.equal(tools.p13PolicyEnforcementEnabled(), true)
  const env = {}
  assert.equal(api.applyProductLauncherSettings({ ...options, env }).ok, true)
  assert.equal(env.TOOLSENABLED_P13_POLICY_ENFORCE, '1')
  const target = tools.getTool('host.exec')
  assert.throws(() => tools.requireP13Decision(target, {}), error => error.code === 'POLICY_DECISION_REQUIRED')
  assert.equal(set('tools.policy_enforcement', false).ok, true)
  assert.equal(tools.requireP13Decision(target, {}), null)
})

test('real audit queue follows saved batch cap without discarding a record', async () => {
  seed({ 'tools.audit_batch_size': 2, 'tools.audit_batch_window_ms': 10 })
  const perf = engine('./src/lib/tool-performance-settings.js')
  perf.performanceSettings({ fresh: true })
  const batches = []
  const queue = engine('./src/lib/audit-admission.js').createAdmissionQueue({
    recordBatch: entries => { batches.push(entries.map(entry => entry.target)); return entries.map(entry => ({ ok: true, durable: true, eventId: entry.target })) }
  })
  const replies = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(target => queue.submit({ action: 'test', target })))
  assert.deepEqual(batches, [['a', 'b'], ['c', 'd'], ['e']])
  assert.deepEqual(replies.map(reply => reply.eventId), ['a', 'b', 'c', 'd', 'e'])
  await queue.close()
})

test('ask closure refuses with the user switch off before touching the ledger', () => {
  seed({ 'agent.close_asks': false })
  let writes = 0
  const gate = new (engine('./src/lib/minor-ledger-agent-gate.js').MinorLedgerAgentControl)({ store: { answerAsk() { writes++ } } })
  assert.throws(() => gate.answer({ id: 'A1', actor: 'test', words: 'done' }), error => error.code === 'AGENT_ASK_DECISION_DISABLED')
  assert.equal(writes, 0)
  set('agent.close_asks', true)
  assert.doesNotThrow(() => gate._assertAskDecisionAllowed())
})

test('ask policy consumes all three saved choices and still requires a tier and owner purchase approval', () => {
  const decide = engine('./src/lib/ask-preference.js').decideAsk
  const context = { permissionSession: engine('./src/lib/permission-tier-policy.js').session({ origin: 'local', tier: 'full' }) }
  const target = { name: 'host.exec', effect: 'local-write' }
  const packet = { agentDecision: { approve: true, rationale: 'The user requested this benign local command.' } }
  for (const [value, result] of [['Stop and wait for me', 'ask'], ['Switch to other work', 'defer'], ['Decide for itself', 'allow']]) {
    assert.equal(set('agent.blocked_question', value).ok, true)
    assert.equal(decide(packet, target, context).decision, result)
  }
  assert.equal(decide(packet, target, {}).decision, 'ask')
  assert.equal(decide(packet, { name: 'pay.record', effect: 'local-write' }, context).decision, 'ask')
})

test('real tool dispatch observes saved approval and P13 changes before a benign ledger record', async () => {
  seed({ 'agent.tool_approvals': true, 'tools.policy_enforcement': false })
  // This case is about approval and P13, not tool mode. A session launched
  // into Native tools only would refuse every dispatch below first.
  await withLaunchedMode(undefined, async () => {
    const tools = engine('./src/lib/tool-registry.js')
    const context = { permissionSession: { origin: 'local', tier: 'full' } }
    const policy = engine('./src/lib/policy.js')
    assert.equal(policy.requiresApproval('system.credential_remove', 'local-write'), true)
    await assert.rejects(tools.executeTool('system.credential_remove', { vaultKey: 'settings_contract_unused', reason: 'legacy_cleanup' }, context), { code: 'APPROVAL_REQUIRED' })
    assert.equal(set('agent.tool_approvals', false).ok, true)
    assert.equal(policy.requiresApproval('system.credential_remove', 'local-write'), false)
    // The refusal above is the only credential-removal dispatch. No real
    // credential operation is performed with the gate off.
    assert.equal(set('purchases.require_owner_approval', false, { confirmation: confirmOff() }).ok, true)
    const args = { amountUsd: 0.01, provider: 'settings-contract-test', reference: 'isolated-one-cent-record', purpose: 'Disposable local ledger test. No payment or merchant.' }
    assert.equal(set('tools.policy_enforcement', true).ok, true)
    await assert.rejects(tools.executeTool('pay.record', args, context), { code: 'POLICY_DECISION_REQUIRED' })
    assert.equal(set('tools.policy_enforcement', false).ok, true)
    const recorded = await tools.executeTool('pay.record', args, context)
    assert.equal(recorded.entry.amountCents, 1)
    const replay = await tools.executeTool('pay.record', args, context)
    assert.equal(replay.replayed, true)
  })
})

test('Autonomous+ continuation survives a real settings write and read with owner provenance', () => {
  const continuation = engine('./src/lib/agent-ledger-continuation.js');
  seed();
  assert.equal(continuation.enabled(saved()), false);
  assert.equal(set('agent.persistent_continuation', true).ok, true);
  assert.equal(continuation.enabled(saved()), true);
  assert.equal(api.readProductSettings(options).rows.find(row => row.id === 'agent.persistent_continuation').value, true);
  assert.equal(set('agent.persistent_continuation', false).ok, true);
  assert.equal(continuation.enabled(saved()), false);
});
