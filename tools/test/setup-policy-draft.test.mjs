import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsDraft, draftSettingsBridge } from '../../src/settings-draft.js'
import { createSetupPolicyDraft, SETUP_PROFILE_DEPENDENCIES, SETUP_APPROVAL_DRAFT_KEY, SETUP_EDITOR_POLICY_KEY, SETUP_ACCOUNT_POLICY_KEY } from '../../src/setup-policy-draft.js'

function fixture() {
  const state = { approvals: 'Stop and wait for me', ideImport: 'none', writes: [], failImport: false, selectionMode: 'manual' }
  const raw = { read: async () => ({ ok: true, rows: [{ id: 'agent.blocked_question', value: state.approvals }] }),
    set: async (id, value) => { state.writes.push(['approval', value]); state.approvals = value; return { ok: true, value } } }
  const scope = { mcSettings: raw, mcProviders: {
    accounts: async () => ({ ok: true, accounts: [{ name: 'fixture' }], policy: { ok: true, policy: { selectionMode: state.selectionMode } } }),
    accountPolicy: async request => { state.selectionMode = request.selectionMode; return { ok: true } },
  }, mcSetup: {
    editorSessionState: async () => ({ ok: true, importPolicy: state.ideImport }),
    setEditorImportPolicy: async value => { state.writes.push(['import', value]); if (state.failImport) return { ok: false, reason: 'fixture import locked' }; state.ideImport = value; return { ok: true } },
  } }
  const draft = createSettingsDraft(), product = draftSettingsBridge(raw, draft)
  const setup = createSetupPolicyDraft({ draft, productSettings: product, scope })
  function profileReceipt() {
    draft.stage('setup:profile', null, async () => { state.writes.push(['profile', await setup.committedValues()]); return { ok: true } }, { after: SETUP_PROFILE_DEPENDENCIES })
  }
  return { state, draft, setup, product, raw, scope, profileReceipt }
}

test('Setup reads canonical policies and overlays pending choices without writing on read', async () => {
  const f = fixture(); f.state.approvals = 'Decide for itself'; f.state.ideImport = 'ask'
  await f.setup.load()
  assert.deepEqual(f.setup.values({ approvals: 'stop', ideImport: 'none' }), { approvals: 'judgement', ideImport: 'ask', failover: 'manual' })
  await f.setup.stage({ approvals: 'other-work', ideImport: 'all-detected' })
  await f.setup.load()
  assert.deepEqual(f.setup.values(), { approvals: 'other-work', ideImport: 'all-detected', failover: 'manual' })
  assert.deepEqual(f.state.writes, [])
})

test('profile loads and commit receipts request saved editor policy without scanning conversations', async () => {
  const f = fixture()
  f.scope.mcSetup.editorSessionState = async options => {
    if (options?.policyOnly !== true) return { ok: false, error: { message: 'Editor discovery is unavailable' } }
    return { ok: true, importPolicy: 'ask' }
  }
  assert.equal((await f.setup.load()).ok, true)
  assert.equal(f.setup.values().ideImport, 'ask')
  assert.equal((await f.setup.committedValues()).ideImport, 'ask')
  assert.equal(f.state.writes.length, 0)
})

for (const order of ['setup-first', 'product-first']) test(`conflicting approval edits use one key and one final native write: ${order}`, async () => {
  const f = fixture(); await f.setup.load()
  if (order === 'setup-first') {
    await f.setup.stage({ approvals: 'other-work' }); f.profileReceipt()
    await f.product.set('agent.blocked_question', 'Decide for itself')
  } else {
    await f.product.set('agent.blocked_question', 'Decide for itself')
    await f.setup.stage({ approvals: 'other-work' }); f.profileReceipt()
  }
  const expected = order === 'setup-first' ? 'Decide for itself' : 'Switch to other work'
  assert.equal(f.draft.size, 2)
  await f.draft.save()
  assert.deepEqual(f.state.writes.map(row => row[0]), ['approval', 'profile'])
  assert.equal(f.state.approvals, expected)
  assert.equal(f.state.writes[1][1].approvals, order === 'setup-first' ? 'judgement' : 'other-work')
})

test('a later Tool use click stays later when Setup is awaiting a native read', async () => {
  const f = fixture(); await f.setup.load()
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.raw.read = async () => { await gate; return { ok: true, rows: [{ id: 'agent.blocked_question', value: f.state.approvals }] } }
  const setupPending = f.setup.stage({ approvals: 'other-work' })
  await f.product.set('agent.blocked_question', 'Decide for itself')
  release(); await setupPending; f.profileReceipt()
  assert.equal(f.setup.values().approvals, 'judgement')
  await f.draft.save(); assert.equal(f.state.approvals, 'Decide for itself')
})

test('returning both controls to native saved values removes their pending writes', async () => {
  const f = fixture(); await f.setup.load()
  await f.setup.stage({ approvals: 'other-work', ideImport: 'ask' })
  assert.equal(f.draft.size, 2)
  await f.setup.stage({ approvals: 'stop', ideImport: 'none' })
  assert.equal(f.draft.has(SETUP_APPROVAL_DRAFT_KEY), false)
  assert.equal(f.draft.has(SETUP_EDITOR_POLICY_KEY), false)
  assert.equal(f.draft.dirty, false)
  assert.deepEqual(f.state.writes, [])
})

test('partial policy Save does not file an agreeing profile, and retry does not repeat successful writes', async () => {
  const f = fixture(); await f.setup.load()
  await f.setup.stage({ approvals: 'other-work', ideImport: 'ask' }); f.profileReceipt()
  // Restaging from Tool use puts this dependency after the profile in ordinary
  // insertion order. The profile receipt must still wait for it.
  await f.product.set('agent.blocked_question', 'Decide for itself')
  f.state.failImport = true
  await assert.rejects(f.draft.save(), /fixture import locked/)
  assert.equal(f.state.writes.some(row => row[0] === 'profile'), false)
  assert.equal(f.draft.has('setup:profile'), true)
  f.state.failImport = false
  await f.draft.save()
  assert.equal(f.state.writes.filter(row => row[0] === 'approval').length, 1)
  assert.deepEqual(f.state.writes.at(-1), ['profile', { approvals: 'judgement', ideImport: 'ask', failover: 'manual' }])
  assert.equal(f.draft.dirty, false)
})

test('an unreadable canonical choice blocks Save and preserves native values', async () => {
  const f = fixture(); f.raw.read = async () => ({ ok: false })
  await assert.rejects(f.setup.stage({ approvals: 'other-work' }), /could not be read/)
  await assert.rejects(f.draft.save(), /could not be read/)
  assert.deepEqual(f.state.writes, [])
})

test('account-policy edits enter the shared draft before a slow native read, so an immediate revert wins', async () => {
  const f = fixture(); await f.setup.load()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const original = f.scope.mcProviders.accounts
  f.scope.mcProviders.accounts = async () => { await gate; return original() }
  const first = f.setup.stage({ failover: 'auto' })
  assert.equal(f.setup.values().failover, 'auto')
  const second = f.setup.stage({ failover: 'manual' })
  assert.equal(f.setup.values().failover, 'manual')
  assert.equal(f.draft.has(SETUP_ACCOUNT_POLICY_KEY), false)
  release(); await Promise.all([first, second])
  await f.draft.save()
  assert.equal(f.state.selectionMode, 'manual')
  assert.deepEqual(f.state.writes, [])
})

test('a pending Accounts read does not delay unrelated Setup policies', async () => {
  const f = fixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const original = f.scope.mcProviders.accounts
  f.scope.mcProviders.accounts = async () => { await gate; return original() }
  const loading = f.setup.load()
  let staged = false
  const staging = f.setup.stage({ approvals: 'other-work' }).then(() => { staged = true })
  try {
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve()
    assert.equal(staged, true)
    assert.equal(f.setup.values().approvals, 'other-work')
  } finally { release(); await Promise.all([loading, staging]) }
})

test('profile preparation times out a stalled editor read and ignores its late answer after a newer choice', async t => {
  const f = fixture(); await f.setup.load()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  f.scope.mcSetup.editorSessionState = () => new Promise(resolve => { release = resolve })
  const preparing = f.setup.stage({ approvals: 'other-work', ideImport: 'all-detected' })
  const rejected = assert.rejects(preparing,/did not answer/)
  for(let turn=0;turn<40;turn++) await Promise.resolve()
  t.mock.timers.tick(10001)
  await rejected
  assert.equal(f.draft.valid,false)
  assert.equal(f.draft.saving,false)
  f.scope.mcSetup.editorSessionState = async () => ({ ok: true, importPolicy: 'none' })
  await f.setup.stage({ approvals: 'stop', ideImport: 'ask' })
  assert.equal(f.draft.valid,true)
  release({ ok: true, importPolicy: 'all-detected' })
  for(let turn=0;turn<40;turn++) await Promise.resolve()
  assert.equal(f.setup.values().ideImport,'ask')
  assert.equal(f.setup.savedValues().ideImport,'none','an expired read cannot change canonical readback')
  await f.draft.save()
  assert.equal(f.state.ideImport,'ask')
  assert.deepEqual(f.state.writes,[['import','ask']])
})
