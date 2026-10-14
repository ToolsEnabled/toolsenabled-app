import assert from 'node:assert/strict'
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { ENGINE_ROOT, ROOT, mainModelParsers, requireShell } from './native-model-test-support.mjs'

const { createAgentHost, narrowTurnOptions } = requireShell('./agent-host.cjs')
const { loadNativeModelSelection } = requireShell('./native-model-selection.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = requireShell('./agent-command-surface.cjs')
const parsers = mainModelParsers()
const exactIds = ['vendor/family:model:v9', 'vendor/' + 'LongName'.repeat(30) + ':version',
  'x'.repeat(2048), ' Mixed/Case:ID ', 'local/quantized:7b']

function stageHost(t, { shared = true, provider = 'codex', client = null } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'appmodels-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const engineRoot = path.join(directory, 'engine')
  cpSync(path.join(ROOT, 'tools/test/fixtures/confined-engine'), engineRoot, { recursive: true })
  if (shared) copyFileSync(path.join(ENGINE_ROOT, 'src/lib/model-dispatch-tiers.js'),
    path.join(engineRoot, 'src/lib/model-dispatch-tiers.js'))
  const cwd = path.join(directory, 'work')
  mkdirSync(cwd)
  const planner = requireShell(path.join(engineRoot, 'src/lib/agent-session-confinement.js'))
  planner.confinedSessionPlan = () => ({ ok: true, tier: 'unrestricted', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {}, servers: [] })
  const module = provider === 'claude' ? ['claude-cli-process.js', 'Claude']
    : provider === 'local' ? ['local-node-process.js', 'Local']
      : client === 'antigravity' ? ['antigravity-cli-process.js', 'Antigravity']
        : ['acp-process.js', 'Acp']
  let providerEngine
  if (provider !== 'codex') {
    const modulePath = path.join(engineRoot, 'src/lib/agent-engine', module[0])
    writeFileSync(modulePath, `const calls = [], adapterCalls = [];
      async function start(options) { calls.push(options); return { threadId: 'fixture-thread',
        adapter: { sendTurn: async request => { adapterCalls.push(request); return { turnId: 'fixture-turn' } },
          interrupt: async () => {}, answerApproval() {} }, close() {} } }
      module.exports = { ROOT_ADMISSION_CONTRACT_VERSION: 1, MODEL_SELECTION_CONTRACT_VERSION: 1,
        calls, adapterCalls, start${module[1]}Session: start, resume${module[1]}Session: start };`)
    providerEngine = requireShell(modulePath)
    const plan = () => ({ ok: true, tier: 'unrestricted', isolated: false,
      threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {}, servers: [],
      configDir: cwd, mcpConfig: path.join(cwd, 'synthetic-tools.json'),
      acp: { provider }, antigravity: { contractVersion: 1 } })
    planner.claudeToolsSessionPlan = plan
    planner.localSessionPlan = plan
    planner.acpSessionPlan = plan
    planner.antigravitySessionPlan = plan
  }
  const enginePath = path.join(engineRoot, 'src/lib/agent-engine/codex-process.js')
  const engine = providerEngine || requireShell(enginePath)
  const host = createAgentHost({ enginePath, defaultCwd: cwd, startProviderProbe: () => provider,
    providerCommandResolver: () => process.execPath, freeMemory: () => 64 * 1024 ** 3 })
  t.after(() => host.closeAll())
  return { host, engine, engineRoot }
}

function surfaceHarness(overrides = {}) {
  const starts = [], sends = []
  const owner = {}
  const principal = { kind: 'window', owner, mayWrite: true, label: 'fixture' }
  const sessions = new Map()
  const host = {
    startSession: async request => { starts.push(request); return { sessionId: request.sessionId,
      threadId: 'fixture-thread', tier: 'unrestricted', effort: 'medium' } },
    sendTurn: async request => { sends.push(request); return { turnId: 'fixture-turn' } },
    closeSession: async request => ({ sessionId: request.sessionId, closed: true }),
  }
  const deps = {}
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    deps[name] = kind === 'function' ? () => null : kind === 'number' ? 128 : kind === 'string' ? ROOT : {}
  }
  Object.assign(deps, {
    agentSessions: sessions, currentAgentHost: () => host, getAgentHost: () => host,
    agentIpcError: (code, message) => { throw Object.assign(new Error(message), { code }) },
    agentPayload: (value, keys) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
        throw Object.assign(new Error('Invalid fixture payload'), { code: 'MC_AGENT_INVALID_PAYLOAD' })
      }
      return value
    },
    boundedAgentString: (value, label, max) => {
      if (typeof value !== 'string' || !value || value.length > max) throw new Error('Invalid fixture string')
      return value
    },
    ...parsers, rendererSafeAgentError: error => error,
    spawnRecordAvailability: () => ({ ok: true }), engineAvailability: () => ({ ok: true }),
    recordSpawnIntent: () => ({ sequence: 1, eventHash: 'fixture', durable: true, signed: true }),
    recordSpawnOutcome: () => {}, recordSessionEnd: session => { session.ended = true },
    ensureWorkspaceRoot: () => ROOT, chosenWorkspaceCwd: () => ROOT,
    sessionProfiles: {}, dialog: { showOpenDialog: async () => ({ canceled: true }) },
    AGENT_EFFORT_VALUES: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    ...overrides,
  })
  return { surface: createAgentCommandSurface(deps), sessions, host, principal, starts, sends }
}

test('production start and send IPC preserve slash, colon, long, padded and boundary model IDs', () => {
  for (const model of exactIds) {
    assert.equal(parsers.parseAgentStart({ sessionId: 'start', tier: 'astra', model }).model, model)
    assert.equal(parsers.parseAgentSend({ sessionId: 'send', text: 'hello', model }).model, model)
  }
})

test('production IPC refuses every ASCII control, blank, non-string and over-long model', () => {
  const invalid = ['', '   ', null, 42, {}, 'x'.repeat(2049),
    ...Array.from({ length: 32 }, (_, index) => 'model' + String.fromCharCode(index)),
    'model' + String.fromCharCode(127)]
  for (const model of invalid) {
    assert.throws(() => parsers.parseAgentStart({ sessionId: 'start', model }), { code: 'MC_AGENT_INVALID_PAYLOAD' })
    assert.throws(() => parsers.parseAgentSend({ sessionId: 'send', text: 'hello', model }), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  }
  assert.throws(() => parsers.parseAgentStart({ sessionId: 'start', model: exactIds[0], effort: 'banana' }),
    { code: 'MC_AGENT_EFFORT_UNKNOWN' })
})

test('shared resolver refuses missing or incompatible paired engine explicitly', t => {
  const { engineRoot } = stageHost(t, { shared: false })
  assert.throws(() => loadNativeModelSelection(engineRoot), { code: 'AGENT_MODEL_RESOLVER_UNAVAILABLE' })
  assert.throws(() => loadNativeModelSelection(null), { code: 'AGENT_MODEL_RESOLVER_UNAVAILABLE' })
  writeFileSync(path.join(engineRoot, 'src/lib/model-dispatch-tiers.js'), 'module.exports = {}')
  assert.throws(() => loadNativeModelSelection(engineRoot), { code: 'AGENT_MODEL_RESOLVER_UNAVAILABLE' })
})

test('actual host startup and adapter turn receive uncatalogued IDs byte-exact', async t => {
  const { host, engine } = stageHost(t)
  for (const [index, model] of exactIds.entries()) {
    const sessionId = 'exact-' + index
    await host.startSession(parsers.parseAgentStart({ sessionId, tier: 'astra', model }))
    assert.equal(engine.calls.at(-1).threadOptions.model, model)
    assert.equal(engine.calls.at(-1).threadOptions.sandbox, 'read-only')
    assert.equal(engine.calls.at(-1).threadOptions.approvalPolicy, 'never')
    const nextModel = model + (model.length < 2048 ? ':turn' : '')
    const result = await host.sendTurn({ sessionId, text: 'hello', options: { model: nextModel } })
    assert.deepEqual(engine.adapterCalls.at(-1).request.options, { model: nextModel, approvalPolicy: 'never' })
    assert.equal(result.model, nextModel)
    assert.equal(host.sessionDeliverySettings(sessionId).model, nextModel)
    await host.closeSession({ sessionId })
  }
})

/* 1.0.50 review CM-4. The usage record names a model the person typed instead of the default row the session
   started on; a model row, chosen at start or by a switch, is still named by its row. */
test('the host knows which sessions run on a typed model name, for the usage record', async t => {
  const { host } = stageHost(t)
  await host.startSession(parsers.parseAgentStart({ sessionId: 'row', tier: 'astra' }))
  assert.equal(host.typedModelFor('row'), null)
  await host.startSession(parsers.parseAgentStart({ sessionId: 'row-model', tier: 'luna', model: 'gpt-5.6-luna' }))
  assert.equal(host.typedModelFor('row-model'), null)
  await host.startSession(parsers.parseAgentStart({ sessionId: 'typed', tier: 'astra', model: 'my-typed-model' }))
  assert.equal(host.typedModelFor('typed'), 'my-typed-model')
  await host.sendTurn({ sessionId: 'row', text: 'hello', options: { model: 'openai/gpt-oss-120b' } })
  assert.equal(host.typedModelFor('row'), 'openai/gpt-oss-120b', 'a switch to a typed name is a typed name')
  await host.sendTurn({ sessionId: 'typed', text: 'hello', options: { model: 'gpt-5.6-luna' } })
  assert.equal(host.typedModelFor('typed'), null, 'a switch to a model row is that row')
  assert.equal(host.typedModelFor('unknown-session'), null)
})

/* 1.0.50 REVIEW-1050 #11. Other model… typed at start as a name that is ANOTHER row's model (here Luna's, on the
   launcher's Astra row) was taken for "not typed", so every usage row was signed as the launcher's default row. */
test('a typed start model that is another row\'s model is a typed name, not the launcher row', async t => {
  const { host } = stageHost(t)
  await host.startSession(parsers.parseAgentStart({ sessionId: 'typed-row-name', tier: 'astra', model: 'gpt-5.6-luna' }))
  assert.equal(host.typedModelFor('typed-row-name'), 'gpt-5.6-luna', 'signed under the launcher row instead of the typed name')
  // The launcher row's own model, and a row's model with no launcher row, are still not typed names.
  await host.startSession(parsers.parseAgentStart({ sessionId: 'launcher-own', tier: 'astra', model: 'gpt-6-astra' }))
  assert.equal(host.typedModelFor('launcher-own'), null)
  await host.startSession(parsers.parseAgentStart({ sessionId: 'no-tier-row', model: 'gpt-5.6-luna' }))
  assert.equal(host.typedModelFor('no-tier-row'), null)
})

test('an explicit startup ID uses the existing default provider when no tier is supplied', async t => {
  const { host, engine } = stageHost(t)
  await host.startSession({ sessionId: 'no-tier', model: exactIds[0] })
  assert.equal(engine.calls[0].threadOptions.model, exactIds[0])
  assert.equal(host.sessionDeliverySettings('no-tier').provider, 'codex')
})

for (const [provider, client, tier] of [
  ['claude', null, 'claude-sonnet'], ['gemini', null, 'gemini'], ['grok', null, 'grok'],
  ['local', null, 'local'], ['gemini', 'antigravity', 'agy-gemini-3-8-flash-high'],
]) {
  test(provider + (client ? '/' + client : '') + ' startup preserves exact IDs and turn overrides refuse honestly', async t => {
    const { host, engine, engineRoot } = stageHost(t, { provider, client })
    for (const [index, model] of exactIds.entries()) {
      const sessionId = 'provider-' + index
      await host.startSession({ sessionId, tier, model })
      assert.equal(engine.calls.at(-1).threadOptions.model, model)
      assert.equal(host.sessionDeliverySettings(sessionId).provider, provider)
      await assert.rejects(host.sendTurn({ sessionId, text: 'hello', options: { model } }),
        { code: 'AGENT_MODEL_TURN_UNSUPPORTED' })
      assert.equal(engine.adapterCalls.length, 0, 'Unsupported override must not silently use the old model')
      await host.closeSession({ sessionId })
    }
    assert.throws(() => narrowTurnOptions({}, { model: 'bad' + String.fromCharCode(10) }, {},
      { engineRoot, provider, client }), { code: 'AGENT_HOST_INVALID_ARGUMENT' })
  })
}

test('host refuses malformed and unsupported-effort model choices before provider calls', async t => {
  const { host, engine, engineRoot } = stageHost(t)
  for (const model of [' ', 'model\ncontrol', 'model\0control', 'x'.repeat(2049), 1]) {
    assert.throws(() => host.startSession({ sessionId: 'bad', tier: 'astra', model }), { code: 'AGENT_MODEL_INVALID' })
    assert.throws(() => narrowTurnOptions({}, { model }, {}, { engineRoot }), { code: 'AGENT_HOST_INVALID_ARGUMENT' })
  }
  assert.throws(() => host.startSession({ sessionId: 'bad-effort', tier: 'astra', model: 'gpt-5.6-luna', effort: 'ultra' }),
    { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' })
  assert.throws(() => narrowTurnOptions({}, { model: 'gpt-6-luna' }, {}, { engineRoot, effort: 'ultra' }),
    { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' })
  assert.equal(engine.calls.length, 0)
  await host.startSession({ sessionId: 'turn-effort', tier: 'astra', effort: 'ultra' })
  await assert.rejects(host.sendTurn({ sessionId: 'turn-effort', text: 'hello', options: { model: 'gpt-5.6-luna' } }),
    { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' })
  assert.equal(engine.adapterCalls.length, 0)
  for (const options of [{ approvalPolicy: 'always' }, [], 'model']) {
    assert.throws(() => narrowTurnOptions({}, options, {}, { engineRoot }), { code: 'AGENT_TURN_OPTION_FORBIDDEN' })
  }
})

test('provider refusal for an uncatalogued ID remains the provider refusal', async t => {
  const { host, engine } = stageHost(t)
  await host.startSession({ sessionId: 'refused', tier: 'astra' })
  const refusal = Object.assign(new Error('Synthetic provider model refusal'), { code: 'PROVIDER_MODEL_UNAVAILABLE' })
  // Replace the fixture adapter response through its existing held-turn seam.
  engine.control.holdTurns = true
  const sending = host.sendTurn({ sessionId: 'refused', text: 'hello', options: { model: exactIds[0] } })
  const rejected = assert.rejects(sending, error => error === refusal)
  while (!engine.pendingTurns.length) await new Promise(resolve => setImmediate(resolve))
  assert.equal(engine.pendingTurns[0].request.options.model, exactIds[0])
  engine.pendingTurns.shift().reject(refusal)
  await rejected
  assert.equal(host.sessionDeliverySettings('refused').model, 'gpt-6-astra')
})

test('command surface forwards exact start and send model fields to its host', async () => {
  const h = surfaceHarness()
  for (const [index, model] of exactIds.entries()) {
    const sessionId = 'surface-' + index
    await h.surface.run('agent:start', { sessionId, tier: 'astra', model }, h.principal)
    assert.equal(h.starts.at(-1).model, model)
    await h.surface.run('agent:send', { sessionId, text: 'hello', model }, h.principal)
    assert.equal(h.sends.at(-1).options.model, model)
  }
})

test('current accepted receipt records its tier on the live session', async () => {
  const h = surfaceHarness()
  await h.surface.run('agent:start', { sessionId: 'source', tier: 'astra', model: 'vendor/old:v1' }, h.principal)
  h.host.sendTurn = async () => ({ turnId: 'accepted', tier: 'sol', model: exactIds[0] })
  await h.surface.run('agent:send', { sessionId: 'source', text: 'hello', model: exactIds[0] }, h.principal)
  assert.equal(h.sessions.get('source').tier, 'sol')
})


for (const replacement of ['restarted-session', 'live-session-identity', 'retained-entry', 'ended-flag', 'ended-state']) {
  test('late accepted receipt does not rewrite the session after ' + replacement, async () => {
    const h = surfaceHarness()
    await h.surface.run('agent:start', { sessionId: 'source', tier: 'astra', model: 'vendor/original:v1' }, h.principal)
    const original = h.sessions.get('source')
    let release, entered
    const waiting = new Promise(resolve => { entered = resolve })
    h.host.sendTurn = async () => { entered(); return new Promise(resolve => { release = resolve }) }
    const sending = h.surface.run('agent:send', { sessionId: 'source', text: 'hello', model: 'vendor/stale:v2' }, h.principal)
    await waiting
    let expectedTier = 'astra'
    if (replacement === 'restarted-session' || replacement === 'retained-entry') {
      h.sessions.delete('source')
      await h.surface.run('agent:start', { sessionId: 'source', tier: 'luna', model: 'vendor/restarted:v3' }, h.principal)
      expectedTier = 'luna'
      if (replacement === 'retained-entry') h.sessions.set('source', original)
    } else if (replacement === 'live-session-identity') h.sessions.set('source', { ...original })
    else if (replacement === 'ended-flag') original.ended = true
    else original.state = 'ended'
    release({ turnId: 'accepted', tier: 'sol', model: 'vendor/stale:v2' })
    assert.equal((await sending).turnId, 'accepted', 'Accepted delivery must remain accepted')
    assert.equal(original.tier, 'astra', 'The old session must not receive stale bookkeeping')
    // 1.0.50 removed the automatic recovery start these defaults once seeded; what remains is that a late
    // acknowledgement never rewrites the live (or restarted) session's own choice.
    const live = h.sessions.get('source')
    if (live && live !== original) assert.equal(live.tier, expectedTier, 'The restarted session keeps its own tier')
  })
}

test('tracked late model acknowledgement keeps accepted delivery and the restarted session choice', async () => {
  const h = surfaceHarness()
  await h.surface.run('agent:start', { sessionId: 'tracked', tier: 'astra', model: 'vendor/original:v1' }, h.principal)
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  h.host.sendTurnTracked = async () => { entered(); return new Promise(resolve => { release = resolve }) }
  const sending = h.surface.sendAutomatic({ sessionId: 'tracked', text: 'hello', model: 'vendor/stale:v2' }, h.principal)
  await waiting
  h.sessions.delete('tracked')
  await h.surface.run('agent:start', { sessionId: 'tracked', tier: 'luna', model: 'vendor/restarted:v3' }, h.principal)
  release({ ok: true, result: { turnId: 'accepted', tier: 'sol', model: 'vendor/stale:v2' } })
  assert.deepEqual(await sending, { ok: true, result: { turnId: 'accepted', tier: 'sol', model: 'vendor/stale:v2' },
    deliveryDisposition: 'accepted' })
  // The restarted session keeps its own choice; the late acknowledgement does not rewrite it.
  assert.equal(h.sessions.get('tracked').tier, 'luna')
})

test('standalone replacement uses its chosen target tier without inheriting the old explicit model', async () => {
  const h = surfaceHarness({ standaloneSwitchHistory: { prepare: async () => ({}), rollback: async () => ({ ok: true }) } })
  h.host.claimStandaloneReplacement = ({ sessionId }) => ({
    sourceSessionId: sessionId, source: { cwd: ROOT }, revision: {}, startDescriptor: {}, assertCurrent() {}, release() {}, cancel() {},
  })
  await h.surface.run('agent:start', { sessionId: 'source', tier: 'astra', model: 'vendor/original:v1' }, h.principal)
  const prepared = await h.surface.run('agent:switch', {
    operation: 'prepare', operationId: 'switch-fixture', sessionId: 'source', tier: 'luna',
  }, h.principal)
  assert.equal(prepared.phase, 'prepared')
  assert.equal(h.starts.at(-1).tier, 'luna')
  assert.equal(Object.hasOwn(h.starts.at(-1), 'model'), false)
  await h.surface.run('agent:switch', {
    operation: 'cancel', operationId: 'switch-fixture', sessionId: 'source',
  }, h.principal)
})
