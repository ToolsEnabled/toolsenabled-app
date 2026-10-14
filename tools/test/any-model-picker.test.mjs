import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mainModelParsers } from './native-model-test-support.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { LAUNCH_TIERS, launchTier, tierEffortIds } from '../../src/orchestration-controls.js'
import { PROVIDER_CHOICES, effortChoicesFor, tierChoicesFor } from '../../src/fleet-tree-copy.js'
import { OTHER_MODEL_VALUE, OTHER_MODEL_LABEL, customModelTier, modelIdProblem, validateModelId } from '../../src/model-picker.js'
import { mountAgentComposePanel } from '../../src/agent-compose-panel.js'
import { TreeWorkspace } from '../../src/tree-workspace.js'
import { mountStandaloneAgent, standaloneStartFrom } from '../../src/tree-standalone-agent.js'
import { createStandaloneTabLedger } from '../../src/standalone-tab-ledger.js'
import { executeFreshStartExistingNode } from '../../src/fresh-start-existing-node.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { resetLiveSessionForTest } from '../../src/agent-session-registry.js'

const require = createRequire(import.meta.url)
const engine = require(join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/model-dispatch-tiers.js'))
const allRows = tierChoicesFor(LAUNCH_TIERS.map(row => row.id))
const exactNames = [' vendor/model:v3.7 ', 'モデル/版:latest', 'x'.repeat(2048), '<model>&"name']
const invalidNames = ['', '   ', 'x'.repeat(2049), ...Array.from({ length: 32 }, (_, i) => 'model' + String.fromCharCode(i)), 'model\x7f']
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

function environment(t) {
  const dom = installDomStandIn()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, JSON.stringify(value)); return true } }
  globalThis.localStorage = storage
  const disposals = []
  t.after(async () => {
    for (const dispose of disposals.reverse()) dispose()
    await settle()
    resetLiveSessionForTest()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
    dom.restore()
  })
  return { ...dom, storage, disposals }
}
function workspace(env) {
  const zoomHost = document.createElement('div')
  document.body.appendChild(zoomHost)
  const graph = { computer: { id: 'picker-fixture' }, zoomHost, nodes: new Map(), chatDrafts: new Map(),
    standaloneAgent: { tierChoices: () => allRows },
    _bindStandaloneDrop() {}, setWide() {}, _renderChatChoices() {}, resize() {}, _applyZoom() {}, _agentFor() {} }
  const owner = graph.workspace = new TreeWorkspace(graph)
  env.disposals.push(() => owner.destroy())
  return owner
}
const spawnField = (owner, name) => owner.root.querySelector('[data-spawn-field="' + name + '"]')
const composeField = (panel, name) => panel.element().querySelector('[data-compose-field="' + name + '"]')
function choose(select, value) { select.value = value; select.dispatch('change') }
function compose(env, submit) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const panel = mountAgentComposePanel({ document, container: host, tiers: allRows, onSubmit: submit })
  panel.open()
  env.disposals.push(() => panel.destroy())
  return panel
}

test('renderer and engine agree on exact IDs, every ASCII control and the 2048-character boundary', () => {
  for (const model of exactNames) {
    assert.equal(validateModelId(model), engine.validateNativeModelId(model))
    assert.equal(modelIdProblem(model), '')
  }
  for (const model of [...invalidNames, null, undefined, 42, {}]) {
    assert.throws(() => validateModelId(model), { code: 'AGENT_MODEL_INVALID' })
    assert.throws(() => engine.validateNativeModelId(model), { code: 'AGENT_MODEL_INVALID' })
    assert.ok(modelIdProblem(model))
  }
})

for (const provider of PROVIDER_CHOICES) {
  test('New agent offers Other model for ' + provider.label + ' and hands on the exact typed start choice', t => {
    const env = environment(t), owner = workspace(env), picked = []
    owner.openStandalone = choice => { picked.push(choice) }
    owner.openSpawnChooser()
    choose(spawnField(owner, 'provider'), provider.id)
    const modelRows = spawnField(owner, 'tier').querySelectorAll('option')
    assert.equal(modelRows.at(-1).textContent, OTHER_MODEL_LABEL)
    choose(spawnField(owner, 'tier'), OTHER_MODEL_VALUE)
    assert.equal(owner.root.querySelector('[data-spawn-model-field]').hidden, false)
    const input = spawnField(owner, 'model')
    input.value = exactNames[0]
    input.dispatch('input')
    owner.root.querySelector('.tree-agent-continue').dispatch('click')
    assert.equal(picked.length, 1)
    assert.equal(picked[0].tier, customModelTier(provider.id))
    assert.equal(picked[0].model, exactNames[0])
    assert.equal(standaloneStartFrom(picked[0]).model, exactNames[0])
  })

  test('compose offers Other model for ' + provider.label + ' and sends its default launcher with the exact name', t => {
    const env = environment(t), submissions = []
    const panel = compose(env, draft => { submissions.push(draft); return { ok: false, message: 'Fixture keeps this form open.' } })
    choose(composeField(panel, 'provider'), provider.id)
    assert.equal(composeField(panel, 'tier').querySelectorAll('option').at(-1).textContent, OTHER_MODEL_LABEL)
    choose(composeField(panel, 'tier'), OTHER_MODEL_VALUE)
    const model = composeField(panel, 'model')
    assert.equal(model.parentNode.hidden, false)
    model.value = exactNames[0]
    model.dispatch('input')
    composeField(panel, 'message').value = 'Use my model.'
    panel.element().querySelector('[data-compose-action="start"]').dispatch('click')
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0].tier, customModelTier(provider.id))
    assert.equal(submissions[0].model, exactNames[0])
  })
}

/* 1.0.50 review CM-6. A tab set to Claude -> Other model… "my-claude-id" re-opens its chooser on that typed name.
   When Claude cannot start here any more, the chooser falls back to a provider that can -- and used to fill the
   Claude name into that provider's Other model…, so confirming scheduled a Codex start with a Claude name. The
   name belongs only to the row it was typed under. */
test('re-opening on a typed name whose provider cannot start does not carry the name to another provider', t => {
  const env = environment(t), picked = []
  const claudeOff = tierChoicesFor(LAUNCH_TIERS.filter(row => row.provider !== 'claude').map(row => row.id))
  const owner = workspace(env)
  owner.graph.standaloneAgent.tierChoices = () => claudeOff
  owner.openStandalone = choice => { picked.push(choice) }
  owner.openSpawnChooser({ start: { tier: customModelTier('claude'), model: 'my-claude-id', effort: '' } })
  assert.notEqual(spawnField(owner, 'provider').value, 'claude')
  assert.notEqual(spawnField(owner, 'tier').value, OTHER_MODEL_VALUE)
  assert.equal(spawnField(owner, 'model').value, '')
  owner.root.querySelector('.tree-agent-continue').dispatch('click')
  assert.equal(picked.length, 1)
  assert.notEqual(picked[0].model, 'my-claude-id')
  assert.notEqual(launchTier(picked[0].tier)?.provider, 'claude')
})

test('re-opening on a typed name whose provider can start keeps it under Other model…', t => {
  const env = environment(t), picked = []
  const owner = workspace(env)
  owner.openStandalone = choice => { picked.push(choice) }
  owner.openSpawnChooser({ start: { tier: customModelTier('claude'), model: 'my-claude-id', effort: '' } })
  assert.equal(spawnField(owner, 'provider').value, 'claude')
  assert.equal(spawnField(owner, 'tier').value, OTHER_MODEL_VALUE)
  assert.equal(spawnField(owner, 'model').value, 'my-claude-id')
  owner.root.querySelector('.tree-agent-continue').dispatch('click')
  assert.deepEqual([picked[0].tier, picked[0].model], [customModelTier('claude'), 'my-claude-id'])
})

test('New agent rejects blank, every ASCII control and oversized typed names before opening a tab', t => {
  const env = environment(t), owner = workspace(env), picked = []
  owner.openStandalone = choice => picked.push(choice)
  owner.openSpawnChooser()
  choose(spawnField(owner, 'tier'), OTHER_MODEL_VALUE)
  for (const model of invalidNames) {
    const input = spawnField(owner, 'model')
    input.value = model; input.dispatch('input')
    const confirm = owner.root.querySelector('.tree-agent-continue')
    assert.equal(confirm.disabled, true)
    confirm.dispatch('click')
    assert.equal(picked.length, 0)
    assert.ok(owner.root.querySelector('.tree-agent-spawn-why').textContent)
  }
})

test('compose refuses invalid custom names for Set and Start before calling the submitter', t => {
  const env = environment(t), submissions = []
  const panel = compose(env, draft => { submissions.push(draft); return { ok: false } })
  choose(composeField(panel, 'tier'), OTHER_MODEL_VALUE)
  composeField(panel, 'message').value = 'A complete brief.'
  for (const model of invalidNames) for (const mode of ['set', 'start']) {
    const input = composeField(panel, 'model')
    input.value = model; input.dispatch('input')
    panel.element().querySelector('[data-compose-action="' + mode + '"]').dispatch('click')
    assert.equal(submissions.length, 0)
    assert.equal(input.getAttribute('aria-invalid'), 'true')
    assert.equal(document.activeElement, input)
  }
})

test('compose readiness repaint retains a padded model and scopes efforts to a typed catalog model', t => {
  const env = environment(t), panel = compose(env, () => ({ ok: false }))
  choose(composeField(panel, 'provider'), 'claude')
  choose(composeField(panel, 'tier'), OTHER_MODEL_VALUE)
  const model = composeField(panel, 'model')
  model.value = exactNames[0]; model.dispatch('input'); model.focus()
  panel.open({ tiers: allRows })
  assert.equal(composeField(panel, 'model').value, exactNames[0])
  assert.equal(panel.draft().model, exactNames[0])
  assert.equal(panel.draft().tier, 'claude-opus')
  composeField(panel, 'model').value = 'claude-haiku-4-5'
  composeField(panel, 'model').dispatch('input')
  assert.deepEqual(composeField(panel, 'effort').querySelectorAll('option').map(option => option.value), [''])
})

test('custom standalone model is shown exactly, saved, restored, and sent byte-exact at restart', async t => {
  const env = environment(t), starts = [], sends = []
  const ledger = createStandaloneTabLedger({ storage: env.storage, computerId: 'picker-computer' })
  const choice = standaloneStartFrom({ tier: 'claude-opus', model: exactNames[0] })
  assert.equal(ledger.remember({ id: 'standalone-11111111-1111-4111-8111-111111111111', name: 'Fixture agent', ...choice }), true)
  assert.equal(ledger.read().tabs[0].model, exactNames[0])
  const bridge = {
    availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: () => () => {}, ownerContext: async () => ({ version: 1, ownerId: 'fixture-owner', currentEpoch: 'fixture-epoch', kind: 'local' }), onOwnerContextChanged: () => () => {}, start: async request => { starts.push(request); return { sessionId: request.sessionId } },
    send: async request => { sends.push(request); return { turnId: 'fixture-turn' } },
    close: async () => ({ closed: true }), interrupt: async () => ({ ok: true }),
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const adapter = mountStandaloneAgent(host, { id: 'standalone-11111111-1111-4111-8111-111111111111', name: 'Fixture agent', live: true,
    bridge, transcript: { bind: async () => ({ ok: true }) }, start: ledger.read().tabs[0] })
  env.disposals.push(() => adapter.dispose())
  await settle()
  assert.equal(host.querySelector('[data-chat-chip="tier"]').textContent, exactNames[0])
  const input = host.querySelector('.chat-input textarea')
  input.value = 'Continue using my model.'; input.dispatch('input')
  host.querySelector('.chat-send').dispatch('click')
  await settle()
  assert.equal(starts.length, 1)
  assert.equal(starts[0].tier, 'claude-opus')
  assert.equal(starts[0].model, exactNames[0])
  assert.equal(mainModelParsers().parseAgentStart(starts[0]).model, exactNames[0])
  assert.equal(sends.length, 1)
  assert.equal(host.querySelector('[data-chat-chip="tier"]').textContent, exactNames[0])
  assert.equal(ledger.update('standalone-11111111-1111-4111-8111-111111111111', { tier: 'astra', effort: 'medium' }), true)
  assert.equal(ledger.read().tabs[0].model, undefined, 'a catalog choice clears the previous typed override')
})

test('tree preferences retain exact names and next-start choices across a stored reload; invalid writes refuse', t => {
  const env = environment(t)
  let serial = 0
  const store = createFleetTreeStore({ computerId: 'picker-tree', storage: env.storage, makeId: prefix => prefix + '-' + (++serial) })
  env.disposals.push(() => store.destroy?.())
  const added = store.addNode({ role: 'worker', message: 'Use the typed model.', tier: 'claude-opus', model: exactNames[0] })
  assert.equal(added.ok, true)
  assert.equal(added.node.model, exactNames[0])
  const nextModelChoice = { tier: 'astra', model: exactNames[1], effort: 'medium' }
  assert.equal(store.setNodeLaunchPreferences(added.node.id, { nextModelChoice }).ok, true)
  for (const model of invalidNames) {
    assert.equal(store.addNode({ role: 'worker', model, tier: 'astra' }).ok, false)
    assert.equal(store.setNodeLaunchPreferences(added.node.id, { model }).ok, false)
    assert.equal(store.setNodeLaunchPreferences(added.node.id, { nextModelChoice: { tier: 'astra', model } }).ok, false)
    assert.equal(store.getNode(added.node.id).model, exactNames[0])
  }
  store.destroy?.()
  const restored = createFleetTreeStore({ computerId: 'picker-tree', storage: env.storage })
  env.disposals.push(() => restored.destroy?.())
  assert.equal(restored.getNode(added.node.id).model, exactNames[0])
  assert.deepEqual(restored.getNode(added.node.id).nextModelChoice, nextModelChoice)
})

test('all requested catalog rows are offered with the CLI effort caps and existing dispatch capacity', () => {
  for (const [id, provider, efforts] of [
    ['gpt-6.1-sol', 'codex', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
    ['claude-sonnet-5-5', 'claude', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-haiku-5-5', 'claude', ['low', 'medium', 'high', 'xhigh', 'max']],
  ]) {
    const row = launchTier(id)
    assert.equal(row.provider, provider)
    assert.ok(allRows.some(choice => choice.id === id && choice.enabled))
    assert.deepEqual([...tierEffortIds(id)], efforts)
    assert.deepEqual(effortChoicesFor(id).filter(choice => choice.id).map(choice => choice.id), efforts)
    const native = engine.TIERS[id] || engine.TREE_ONLY_SPAWN_TIERS[id]
    assert.equal(native.provider, provider)
    for (const effort of efforts) assert.equal(engine.validateNativeModelEffort(native.cliModel, effort, { provider }), effort)
    if (provider === 'codex') {
      assert.equal(row.treeOnly, true)
      assert.equal(engine.TIERS[id], undefined)
    } else {
      assert.deepEqual([...row.seats], ['claude-1', 'claude-2', 'claude-3', 'claude-4'])
    }
  }
})

test('a clean restart uses its saved custom choice and drops an incompatible old effort', async () => {
  const starts = [], preferences = []
  const raw = exactNames[0]
  const result = await executeFreshStartExistingNode({
    node: { id: 'fixture-node', sessionId: 'old-session', tier: 'astra',
      nextModelChoice: { tier: 'claude-opus', model: raw, effort: null } },
    bridge: { close: async () => ({ ok: true }), start: async request => { starts.push(request); return { ok: true, sessionId: 'next-session' } } },
    sourceIsReal: true, canStart: () => true,
    sessionState: { nodeIds: new Map([['old-session', 'fixture-node']]), efforts: new Map([['old-session', 'ultra']]) },
    transcriptStore: { get: () => ({ effort: 'ultra' }), remove: async () => true },
    treeStore: { detachSession() {}, attachSession: () => ({ ok: true }), setNodeStatus() {}, setNodeReply() {},
      setNodeLaunchPreferences: (_, choice) => { preferences.push(choice); return { ok: true } } },
  })
  assert.equal(result.ok, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].tier, 'claude-opus')
  assert.equal(starts[0].model, raw)
  assert.equal(starts[0].effort, undefined)
  assert.deepEqual(preferences, [{ tier: 'claude-opus', model: raw, effort: '', nextModelChoice: null }])
})

test('a malformed stored restart choice refuses before closing or starting a provider', async () => {
  for (const choice of [...invalidNames.map(model => ({ tier: 'astra', model })), { tier: 'missing-provider', model: 'valid' }]) {
    const calls = []
    const result = await executeFreshStartExistingNode({
      node: { id: 'fixture-node', sessionId: 'old-session', tier: 'astra', nextModelChoice: choice },
      bridge: { close: async () => calls.push('close'), start: async () => calls.push('start') },
      sourceIsReal: true, canStart: () => true,
      sessionState: { nodeIds: new Map([['old-session', 'fixture-node']]) },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AGENT_MODEL_INVALID')
    assert.ok(result.reason)
    assert.deepEqual(calls, [])
  }
})

test('a refused custom-model restart retains the provider sentence', async () => {
  const message = 'Your provider does not offer this model for this account.'
  const result = await executeFreshStartExistingNode({
    node: { id: 'fixture-node', tier: 'astra', model: exactNames[0] },
    bridge: { start: async request => {
      assert.equal(request.model, exactNames[0])
      return { ok: false, code: 'PROVIDER_MODEL_UNAVAILABLE', message }
    } },
    sourceIsReal: true, canStart: () => true, sessionState: { nodeIds: new Map() },
    refusalCodeFromResult: result => result.code,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, message)
})

test('a refused model-preference save stops a clean restart before the provider starts', async () => {
  for (const savedChoice of [{ ok: false }, { ok: true, snapshot: { persistenceFailed: true } }]) {
    const starts = []
    const result = await executeFreshStartExistingNode({
      node: { id: 'fixture-node', tier: 'astra', model: exactNames[0] },
      bridge: { start: async request => { starts.push(request); return { ok: true, sessionId: 'next-session' } } },
      sourceIsReal: true, canStart: () => true, sessionState: { nodeIds: new Map() },
      treeStore: { detachSession() {}, setNodeStatus() {}, attachSession: () => ({ ok: true }), setNodeReply() {},
        setNodeLaunchPreferences: () => savedChoice },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MC_TREE_COMMAND_MODEL_PREFERENCE_SAVE_FAILED')
    assert.ok(result.reason.includes('could not be saved'))
    assert.deepEqual(starts, [])
  }
})
