import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
// Exercise the current renderer declarations. The surrounding view, transport,
// provider continuation and storage are inert; no real account/session starts.
const source = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
function declaration(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'))
  if (start < 0) throw new Error('Missing renderer declaration: ' + name)
  const end = source.indexOf('\n  }', start)
  if (end < 0) throw new Error('Unterminated renderer declaration: ' + name)
  return source.slice(start, end + 4)
}
const choiceState = source.match(/^  const managedSlotChoices = .+$/m)?.[0]
if (!choiceState) throw new Error('Missing managed choice state')
const code = [choiceState, ...['statusSink', 'continueNodeWithChoice', 'configureManagedSlot'].map(declaration)].join('\n')
function fixture({ route = 'handoff', reason = 'The selected account has no available allowance.', succeeds = false, busy = false } = {}) {
  const node = { id: 'synthetic-node', sessionId: 'old-session', createdAt: 1, treeId: 'synthetic-tree', tier: 'test-tier', role: 'worker' }
  const calls = { attempts: 0, saved: 0, queued: 0, displayed: [], workspace: [] }
  const selected = { tier: 'test-tier', account: 'second', provider: 'codex' }
  const store = { getNode: () => node, setNodeLaunchPreferences: () => { calls.saved++; return { ok: true } } }
  const perform = async out => {
    calls.attempts++
    if (!succeeds) { if (reason) out.textContent = reason; return false }
    return true
  }
  const scope = {
    window: {}, destroyed: false, treeStore: store, callerCircleRefusal: () => null,
    currentDataSource: () => 'local', isWriteEnabled: () => true, START_CONTROL_FLAG: 'synthetic',
    nodeCleanupPending: () => false, nodeReplacementFlight: { busy: () => false },
    recoveryCoordinator: () => ({ isRecovering: () => false }),
    MANAGED_SLOT_ACTIONS: { 'set-node-account': 'account' },
    loadAccounts: async () => ({ available: true, accounts: [{ name: 'second', provider: 'codex' }] }),
    transcriptStore: { get: () => ({ account: 'first', provider: 'codex' }) },
    TREE_DEFAULT_STARTABLE_TIERS: ['test-tier'], LAUNCH_TIERS: [{ id: 'test-tier', provider: 'codex' }],
    sessionNodeIds: new Map([['old-session', node.id]]), sessionAccountNames: new Map([['old-session', 'first']]),
    sessionEfforts: new Map(), savedSessionEffort: () => 'medium', tierEffortOf: () => 'medium',
    engineEffortsFor: () => ['medium'], EFFORT_CHOICES: ['medium'], orgAvailability: { roles: [] },
    planManagedSlotChoice: () => ({ ok: true, changed: true, field: 'account', choice: selected, previous: { account: 'first' } }),
    continuationRouteFor: () => ({ route, tier: 'test-tier', account: 'second', provider: 'codex', changesModel: false, changesProvider: false }),
    continueNodeOnAnotherAccount: async (_node, out) => perform(out),
    continueNodeOnAnotherModel: async (_node, _tier, out) => perform(out),
    resumeNodeSession: async (_node, options) => perform(options.out),
    SWITCH_PANEL: { continuing: 'Continuing…', failed: 'The switch did not take. The saved conversation and queued messages are kept.' },
    RESUME_PANEL: { done: 'Resumed.' }, PALETTE_PANEL: { cleared: 'Cleared.' },
    setOrgStatus: (sentence, state) => calls.displayed.push({ sentence, state }),
    setWorkspaceStatus: (id, sentence, state) => calls.workspace.push({ id, sentence, state }),
    nodeBusy: () => busy, pendingModelChoice: () => null,
    queueModelChoice: () => calls.queued++, notifyNodeStatusListeners: () => {},
  }
  const api = vm.runInNewContext(code + '\n;({configureManagedSlot, statusSink})', scope)
  const run = override => api.configureManagedSlot({ action: 'set-node-account', choice: 'second', expectedSessionId: 'old-session', ...override }, node)
  return { api, run, node, calls, reason }
}
for (const route of ['handoff', 'resume']) {
  test(route + ' returns the downstream refusal already displayed to the person', async () => {
    const f = fixture({ route })
    const result = await f.run()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'TREE_CONFIGURATION_REFUSED')
    assert.equal(result.reason, f.reason)
    assert.equal(f.calls.displayed.at(-1).sentence, f.reason)
    assert.equal(f.calls.attempts, 1)
    assert.equal(f.calls.saved, 0)
    assert.equal(f.node.sessionId, 'old-session')
  })
}
test('a silent refusal remains refused with a visible retained-work sentence', async () => {
  const f = fixture({ reason: null })
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /configuration could not be applied|switch did not take/)
  assert.ok(f.calls.displayed.at(-1).sentence)
  assert.equal(f.calls.saved, 0)
})
test('an accepted account choice keeps its applied outcome and saves preferences once', async () => {
  const f = fixture({ succeeds: true })
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(result.status, 'applied')
  assert.equal(f.calls.attempts, 1)
  assert.equal(f.calls.saved, 1)
})
test('a stale expected session refuses before continuation or preference changes', async () => {
  const f = fixture()
  const result = await f.run({ expectedSessionId: 'different-session' })
  assert.equal(result.ok, false)
  assert.equal(f.calls.attempts, 0)
  assert.equal(f.calls.saved, 0)
})
test('a busy slot queues its choice without starting continuation', async () => {
  const f = fixture({ busy: true })
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(result.status, 'pending')
  assert.equal(f.calls.queued, 1)
  assert.equal(f.calls.attempts, 0)
  assert.equal(f.calls.saved, 0)
})

/* REVIEW P5. A stopped Codex or Claude slot has no session catalog, and its
   depth was checked against every Codex word (EFFORT_CHOICES) whatever the
   model: `high` on a stopped Haiku 4.5 slot, or `xhigh` on Opus 4.6, was
   accepted and reported pending, then dropped to no depth at the next start.
   It is now checked against that model's own list, and a model change scopes
   the saved depth to the new model. Driven through the real planner, table
   and copy module. */
const { planManagedSlotChoice, MANAGED_SLOT_ACTIONS } = await import('../../src/managed-slot-choice.js')
const { LAUNCH_TIERS } = await import('../../src/orchestration-controls.js')
const { EFFORT_CHOICES, effortChoicesFor } = await import('../../src/fleet-tree-copy.js')
const { savedSessionEffort } = await import('../../src/manual-account-continuation.js')
function stoppedSlot({ tier, effort = '' }) {
  const node = { id: 'stopped-node', sessionId: null, createdAt: 1, treeId: 'synthetic-tree', tier, effort, role: 'worker' }
  const saved = []
  const scope = {
    window: {}, destroyed: false, callerCircleRefusal: () => null,
    treeStore: { getNode: () => node, setNodeLaunchPreferences: (...args) => { saved.push(args); return { ok: true } } },
    currentDataSource: () => 'local', isWriteEnabled: () => true, START_CONTROL_FLAG: 'synthetic',
    nodeCleanupPending: () => false, nodeReplacementFlight: { busy: () => false },
    recoveryCoordinator: () => ({ isRecovering: () => false }),
    MANAGED_SLOT_ACTIONS, planManagedSlotChoice, LAUNCH_TIERS, EFFORT_CHOICES, effortChoicesFor, savedSessionEffort,
    readStartableTiers: async () => ({ answered: true, tiers: LAUNCH_TIERS.map(row => row.id) }),
    loadAccounts: async () => ({ available: true, accounts: [] }),
    engineModelCatalog: { read: async () => null }, engineEffortsFor: () => [],
    transcriptStore: { get: () => null }, TREE_DEFAULT_STARTABLE_TIERS: ['astra'],
    sessionNodeIds: new Map(), sessionAccountNames: new Map(), sessionEfforts: new Map(),
    tierEffortOf: id => LAUNCH_TIERS.find(row => row.id === id)?.effort || '', orgAvailability: { roles: [] },
    setOrgStatus: () => {}, setWorkspaceStatus: () => {}, nodeBusy: () => false, pendingModelChoice: () => null,
    queueModelChoice: () => { throw new Error('a stopped slot queues nothing') }, notifyNodeStatusListeners: () => {},
  }
  const api = vm.runInNewContext(code + '\n;({configureManagedSlot})', scope)
  return { saved, run: (action, choice) => api.configureManagedSlot({ action, choice }, node) }
}
test('a stopped slot is offered only the depths its own model takes', async () => {
  for (const [tier, effort] of [['claude-haiku-4-5', 'high'], ['claude-opus-4-6', 'xhigh'], ['luna', 'ultra'], ['astra', 'minimal']]) {
    const f = stoppedSlot({ tier })
    const result = await f.run('set-node-effort', effort)
    assert.equal(result.ok, false, `${tier}/${effort} was accepted as pending`)
    assert.equal(result.reason, 'This model does not offer that effort choice.', `${tier}/${effort}: ${result.reason}`)
    assert.equal(f.saved.length, 0, `${tier}/${effort}: nothing is saved`)
  }
  for (const [tier, effort] of [['claude-opus-4-6', 'max'], ['claude-opus-5', 'xhigh'], ['luna', 'xhigh']]) {
    const f = stoppedSlot({ tier })
    const result = await f.run('set-node-effort', effort)
    assert.equal(result.ok, true, `${tier}/${effort}: ${result.reason}`)
    assert.equal(result.status, 'pending')
    assert.equal(f.saved.at(-1)[1].effort, effort)
  }
})
test('a model change on a slot keeps the saved depth only where the new model takes it', async () => {
  const opusAtXhigh = stoppedSlot({ tier: 'claude-opus', effort: 'xhigh' })
  const toOpus46 = await opusAtXhigh.run('set-node-model', 'claude-opus-4-6')
  assert.equal(toOpus46.ok, true, toOpus46.reason)
  assert.equal(toOpus46.requested.effort, null, 'xhigh was reported for Opus 4.6, which has none')
  assert.equal(opusAtXhigh.saved.at(-1)[1].effort, '', 'Opus 4.6 is saved at "Model default"')
  const toOpus5 = await stoppedSlot({ tier: 'claude-opus', effort: 'xhigh' }).run('set-node-model', 'claude-opus-5')
  assert.equal(toOpus5.requested.effort, 'xhigh', 'Opus 5 takes xhigh, so it is kept')
  const astraUltra = planManagedSlotChoice({ action: 'set-node-model', value: 'luna', tiers: LAUNCH_TIERS,
    current: { tier: 'astra', provider: 'codex', effort: 'ultra', account: null, role: '' },
    startable: LAUNCH_TIERS.map(row => row.id), answered: true })
  assert.equal(astraUltra.choice.effort, 'medium', 'GPT-5.6-Luna has no ultra, so it takes its own default')
})
