import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { PRODUCT_SETTING_IDS } from '../../src/research-settings.js'
import { RESOURCE_CONTROLS, resourceFormValues, validateResourceForm } from '../../src/resource-settings.js'
import { WRITE_ACTION_FLAGS } from '../../src/write-flags.js'
import { matchingAutonomy, answersForAutonomy, deriveProfile, PROFILE_INTENT } from '../../src/setup-profile.js'
import { WORKING_PROFILES, PROFILE_PRODUCT_VALUES, PROFILE_PRODUCT_PRESERVED, PROFILE_LOCAL_PRESERVED, PROFILE_RESOURCE_KEYS, PROFILE_RESOURCE_PRESERVED, workingProfilePlan, matchWorkingProfile } from '../../src/settings-profile-policy.js'

const flagIds = WRITE_ACTION_FLAGS.map(flag => flag.id)
const totalBytes = 32 * 1024 ** 3
const make = (id, tier = 'standard') => workingProfilePlan(id, { tier, writeFlagIds: flagIds, totalBytes })
const snapshot = plan => ({ product: Object.entries(plan.product).map(([id, value]) => ({ id, value, present: true })),
  setup: { writeFlags: { ...plan.setup.writeFlags }, intent: { ...plan.setup.intent }, accounts: { applicable: true } },
  resources: { ...plan.resources }, resourceApplicable: true })

test('switching any working preset preserves the explicit every-turn rules choice', () => {
  assert.ok(PROFILE_PRODUCT_PRESERVED['rules.require_read_each_turn'])
  for (const profile of WORKING_PROFILES) {
    assert.equal(Object.hasOwn(make(profile.id).product, 'rules.require_read_each_turn'), false)
  }
})

test('every shipped product control has exactly one explicit profile disposition', () => {
  const mapped = Object.keys(PROFILE_PRODUCT_VALUES), kept = Object.keys(PROFILE_PRODUCT_PRESERVED)
  assert.equal(new Set([...mapped, ...kept]).size, mapped.length + kept.length, 'a field cannot be both applied and preserved')
  assert.deepEqual([...mapped, ...kept].sort(), [...PRODUCT_SETTING_IDS].sort())
  for (const [id, reason] of Object.entries(PROFILE_PRODUCT_PRESERVED)) assert.ok(reason.length > 30, id)
  assert.equal(mapped.length, 19)
  // agent.product_source_writes (owner, 2026-09-19) is a separate opt-in a
  // profile never lifts, so it joins the preserved list: 21 -> 22.
  // audit.activity (owner direction 2026-09-20, T782) is no longer a preset
  // value: detailed auditing is opt-in setup under Advanced, so it moves from
  // the applied list to the preserved list: 20/22 -> 19/23. The reusable-slot
  // shape (fleet.tree_width, fleet.tree_depth; a8aee112a) is the person's own
  // tree layout and joins the preserved list: 23 -> 25.
  assert.equal(kept.length, 28)
  assert.equal(mapped.length + flagIds.length + PROFILE_INTENT.filter(field => field.id !== 'approvals').length + PROFILE_RESOURCE_KEYS.length, 37, 'approval intent shares the canonical product field')
  assert.ok(kept.includes('agent.agent_api'))
  assert.ok(kept.includes('agent.product_source_writes'))
  assert.ok(kept.includes('agent.subagent_route'))
  assert.ok(kept.includes('audit.activity'))
  /* T781/T783 rows (M10's audit.enabled and ledger.verify_history, M7's
     diagnostics.retention): explicit setups under Advanced, never a preset's. */
  for (const id of ['audit.enabled', 'ledger.verify_history', 'diagnostics.retention']) {
    assert.ok(kept.includes(id), id)
    assert.equal(Object.hasOwn(PROFILE_PRODUCT_VALUES, id), false, `no preset writes ${id}`)
    assert.match(PROFILE_PRODUCT_PRESERVED[id], /Advanced/, `${id}'s reason points at where the setup lives`)
  }
})

/* BASIC IS BASIC (owner direction 2026-09-20, T782): a working preset never
   switches detailed activity auditing or enforced resource admission on. Both
   are explicit setup under Advanced; a preset carries pacing values for the
   person who has enabled admission and leaves the switch itself alone. */
test('no working preset turns detailed auditing or enforced resource admission on', () => {
  for (const tier of ['guided', 'standard', 'unrestricted']) for (const profile of WORKING_PROFILES) {
    const plan = make(profile.id, tier)
    assert.equal(Object.hasOwn(plan.product, 'audit.activity'), false, `${tier}/${profile.id}: audit.activity must not be staged`)
    assert.equal(Object.hasOwn(plan.resources, 'mode'), false, `${tier}/${profile.id}: the admission mode must not be staged`)
    assert.ok(!Object.values(plan.product).includes('Full'), `${tier}/${profile.id}: nothing in the preset spells Full`)
    assert.ok(!Object.values(plan.resources).includes('mechanical'), `${tier}/${profile.id}: nothing in the preset spells mechanical`)
  }
  assert.match(PROFILE_PRODUCT_PRESERVED['audit.activity'], /Advanced/, 'the preserved reason points at where the setup lives')
  assert.match(PROFILE_RESOURCE_PRESERVED.mode, /Advanced/, 'so does the admission reason')
  /* A person who DID switch auditing on, or admission on, keeps that through
     every preset: the preserved rows never count against a match. */
  for (const audit of ['Off', 'Essential', 'Full']) for (const mode of ['off', 'mechanical', 'controller', 'both']) {
    const plan = make('balanced'), state = snapshot(plan)
    state.product.push({ id: 'audit.activity', value: audit, present: true })
    state.resources.mode = mode
    assert.equal(matchWorkingProfile(plan, state).matches, true, `${audit}/${mode} stays the person's and still matches Balanced`)
  }
})

test('resource profile covers every pacing control except the admission mode and explicitly preserved per-program RAM calibration', () => {
  const disposition = RESOURCE_CONTROLS.filter(control => !control.provider).map(control => control.key || control.name)
  assert.deepEqual([...PROFILE_RESOURCE_KEYS].sort(), disposition.sort())
  assert.deepEqual(Object.keys(PROFILE_RESOURCE_PRESERVED), ['mode'])
  assert.deepEqual(RESOURCE_CONTROLS.filter(control => control.provider).map(control => control.provider), ['claude', 'codex', 'gemini', 'grok', 'local'])
  for (const profile of WORKING_PROFILES) assert.equal(Object.hasOwn(make(profile.id).resources, 'providerBytes'), false, 'Working profiles preserve every program’s RAM calibration')
})

test('every ordinary Settings tunable is either a mapped action flag or an explained personal/consent exclusion', async () => {
  register('./helpers/css-stub-loader.mjs', import.meta.url)
  const { SETTINGS } = await import('../../src/views/settings.js')
  const writable = SETTINGS.filter(row => !['action', 'custom', 'link'].includes(row.type)).map(row => row.id)
  assert.deepEqual(writable.sort(), [...flagIds.map(id => `write_${id}`), ...Object.keys(PROFILE_LOCAL_PRESERVED)].sort())
  /* vault_credentials joined this_computer_programs at T254 (6cd8427a,
     2026-09-17): it stores no mc.set.* preference either -- the vault IS
     the store, per src/views/settings.js's own comment on that row -- so it
     is exactly the same kind of exclusion, not a second category. */
  assert.deepEqual(SETTINGS.filter(row => row.type === 'custom').map(row => row.id).sort(),
    ['this_computer_programs', 'vault_credentials'], 'mounted program controls are not profile policy tunables')
  assert.deepEqual(SETTINGS.filter(row => row.type === 'link').map(row => row.id).sort(),
    ['this_computer_account', 'this_computer_messaging'], 'navigation links do not write a policy value')
  assert.deepEqual(SETTINGS.filter(row => row.type === 'action').map(row => row.id).sort(),
    ['cloud_mirror_setup', 'compare_files', 'ledger_archive', 'this_computer_feedback'])
})

for (const tier of ['guided', 'standard', 'unrestricted']) for (const profile of WORKING_PROFILES) test(`${tier} ${profile.label}: complete coherent plan, actual values and individual overrides`, () => {
  const plan = make(profile.id, tier), state = snapshot(plan)
  assert.equal(matchWorkingProfile(plan, state).matches, true)
  assert.equal(plan.product['purchases.require_owner_approval'], true)
  assert.equal(Object.hasOwn(plan.product, 'audit.activity'), false, 'auditing is the person\'s own setup, never a preset value')
  assert.equal(plan.product['fleet.concurrent_shared_writes'], false)
  assert.equal(plan.product['capability.elevation_survives_restart'], false)
  assert.equal(plan.product['tools.credential_check_interval_seconds'], 0)
  assert.equal(Object.hasOwn(plan.resources, 'mode'), false, 'enforced admission is the person\'s own setup, never a preset value')
  assert.ok(plan.resources.cpuBusyPercent < plan.resources.cpuCeilingPercent)
  assert.ok(plan.resources.startIntervalMs <= plan.resources.busyStartIntervalMs)
  assert.notEqual(plan.setup.intent.attach, 'adopt')
  if (tier === 'guided') {
    assert.equal(plan.product['agent.tool_approvals'], true)
    assert.equal(plan.product['agent.close_asks'], false)
    assert.equal(plan.product['agent.blocked_question'], 'Stop and wait for me')
    assert.equal(plan.setup.writeFlags.dispatch, false)
    assert.equal(plan.setup.intent.ideImport, 'none')
    if (['independent', 'autonomous', 'autonomous-plus'].includes(profile.id)) assert.match(plan.description,/Tool approvals and stop-and-wait stay on/)
  }
  // Every applicable output participates in identity, including constant
  // values and controls invisible in Simple view. A receipt name is no proof.
  for (const row of state.product) {
    const changed = snapshot(plan); changed.product.find(item => item.id === row.id).value = Symbol('different')
    assert.ok(matchWorkingProfile(plan, changed).differences.includes(row.id), row.id)
  }
  for (const id of flagIds) {
    const changed = snapshot(plan); changed.setup.writeFlags[id] = !changed.setup.writeFlags[id]
    assert.equal(matchWorkingProfile(plan, changed).matches, false, id)
  }
  for (const id of Object.keys(plan.setup.intent)) {
    const changed = snapshot(plan); changed.setup.intent[id] = 'different'
    assert.equal(matchWorkingProfile(plan, changed).matches, false, id)
  }
  for (const id of PROFILE_RESOURCE_KEYS) {
    const changed = snapshot(plan); changed.resources[id] = 'different'
    assert.equal(matchWorkingProfile(plan, changed).matches, false, id)
  }
  const base = { ...plan.resources, providerBytes: { claude: 768 * 1024 ** 2, codex: 2048 * 1024 ** 2, local: 24576 * 1024 ** 2 } }
  const validation = validateResourceForm(resourceFormValues(base), base)
  assert.equal(validation.ok, true, validation.reason)
  assert.deepEqual(validation.value.providerBytes, base.providerBytes)
})

test('Careful, Balanced and Independent have deliberate policy and pacing differences', () => {
  const careful = make('careful'), balanced = make('balanced'), independent = make('independent')
  assert.equal(careful.setup.intent.approvals, 'stop')
  assert.equal(careful.setup.intent.attach, 'mirror')
  assert.equal(careful.setup.intent.ideImport, 'none')
  assert.equal(careful.product['capability.elevation_duration'], 15)
  assert.equal(careful.resources.maxConcurrentStarts, 2)
  assert.equal(balanced.setup.intent.approvals, 'other-work')
  assert.equal(balanced.product['agent.tool_approvals'], true)
  assert.equal(balanced.resources.maxConcurrentStarts, 8)
  assert.equal(independent.product['agent.tool_approvals'], false)
  assert.equal(independent.resources.maxConcurrentStarts, 16)
  assert.equal(independent.product['fleet.max_declared_agents'], 256)
})

test('profiles preserve the audit window and model tuning at every permission level and RAM capacity', () => {
  const preservedChoices = {
    'audit.retention': 'Keep everything',
    'model.local_context_tokens': 12288,
    'model.local_thinking': 'Reasoning',
    'model.local_keep_alive_minutes': 27,
  }
  for (const tier of ['guided', 'standard', 'unrestricted']) for (const { id } of WORKING_PROFILES) {
    for (const capacityGiB of [null, 2, 8, 16, 128]) {
      const plan = workingProfilePlan(id, { tier, writeFlagIds: flagIds, totalBytes: capacityGiB === null ? undefined : capacityGiB * 1024 ** 3 })
      const state = snapshot(plan)
      for (const [key, value] of Object.entries(preservedChoices)) {
        assert.equal(Object.hasOwn(plan.product, key), false, `${tier}/${id}/${capacityGiB}: ${key} must never be staged`)
        assert.equal(Object.hasOwn(PROFILE_PRODUCT_PRESERVED, key), true, `${key} has a visible preservation reason`)
        state.product.push({ id: key, value, present: true })
      }
      assert.equal(matchWorkingProfile(plan, state).matches, true, 'saved or pending preserved preferences do not turn a matching profile into Custom')
      state.product.find(row => row.id === 'agent.tool_approvals').value = !plan.product['agent.tool_approvals']
      assert.equal(matchWorkingProfile(plan, state).matches, false, 'an individual change to a mapped action policy still makes Custom')
    }
  }
})

test('Autonomous+ extends the six-choice slider while retaining purchase and access boundaries', () => {
  assert.deepEqual(WORKING_PROFILES.map(({ id }) => id), ['locked', 'careful', 'balanced', 'independent', 'autonomous', 'autonomous-plus'])
  const locked = make('locked'), autonomous = make('autonomous')
  assert.equal(locked.resources.maxConcurrentStarts, 1)
  assert.equal(locked.product['agent.tool_approvals'], true)
  assert.equal(locked.product['capability.elevation_duration'], 5)
  assert.equal(autonomous.resources.maxConcurrentStarts, 32)
  assert.equal(autonomous.product['agent.tool_approvals'], false)
  for (const plan of [locked, autonomous]) {
    assert.equal(plan.product['purchases.require_owner_approval'], true)
    assert.equal(plan.product['capability.elevation_survives_restart'], false)
    for (const id of ['agent.agent_api', 'research.pipeline', 'research.runner_agent', 'research.runner_process', 'research.runner_http']) {
      assert.equal(Object.hasOwn(plan.product, id), false, `${id} remains a separate saved choice`)
    }
  }
})

test('small-machine spare RAM scales to capacity; missing reads and preserved fields cannot fake a match', () => {
  const plan = workingProfilePlan('careful', { tier: 'guided', writeFlagIds: flagIds, totalBytes: 2 * 1024 ** 3 })
  assert.equal(plan.resources.reserveBytes, 512 * 1024 ** 2)
  for (const id of ['careful', 'balanced', 'independent']) {
    const small = workingProfilePlan(id, { tier: 'standard', writeFlagIds: flagIds, totalBytes: 2 * 1024 ** 3 })
    assert.equal(small.resources.reserveBytes, (id === 'careful' ? 512 : 256) * 1024 ** 2)
  }
  const state = snapshot(plan)
  state.product.push({ id: 'agent.agent_api', value: 'Disabled' }, { id: 'agent.subagent_route', value: 'Never on your tree' })
  state.resources.providerBytes = { local: 48000 * 1024 ** 2 }
  assert.equal(matchWorkingProfile(plan, state).matches, true)
  state.product = state.product.filter(row => row.id !== 'agent.tool_approvals')
  assert.equal(matchWorkingProfile(plan, state).matches, false)
  assert.throws(() => make('unknown'), /Choose one/)
})

test('absent accounts and remote-only resources are explicit exclusions, not substituted defaults', () => {
  const plan = make('independent'), state = snapshot(plan)
  state.setup.intent.failover = null; state.setup.accounts.applicable = false
  state.resources = null; state.resourceApplicable = false
  assert.equal(matchWorkingProfile(plan, state).matches, true)
  state.setup.accounts.applicable = true
  assert.equal(matchWorkingProfile(plan, state).matches, false)
})

test('Setup autonomy is Custom after edits; equivalent Guided outcomes use history only as a tie-breaker', () => {
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const profile = deriveProfile(answersForAutonomy('assisted'), { tier, writeFlagIds: flagIds })
    const state = { tier, writeFlags: { ...profile.writeFlags }, intent: { ...profile.intent }, preferred: 'assisted' }
    assert.equal(matchingAutonomy(state), 'assisted')
    state.writeFlags['agent-session'] = false
    assert.equal(matchingAutonomy(state), 'custom')
    state.writeFlags['agent-session'] = true
    if (tier === 'guided') assert.equal(matchingAutonomy({ ...state, preferred: 'autonomous' }), 'autonomous')
    else assert.equal(matchingAutonomy({ ...state, preferred: 'autonomous' }), 'assisted')
  }
})

test('Autonomous+ sustains authorized work with headroom and pending approvals, and survives saving', () => {
  const previous = make('autonomous'), next = make('autonomous-plus');
  assert.ok(next.resources.maxConcurrentStarts <= previous.resources.maxConcurrentStarts);
  assert.ok(next.resources.cpuCeilingPercent < previous.resources.cpuCeilingPercent);
  assert.ok(next.resources.reserveBytes > previous.resources.reserveBytes);
  assert.ok(next.resources.settleMs > previous.resources.settleMs);
  assert.deepEqual(next.setup.writeFlags, previous.setup.writeFlags, 'persistence is not a new permission tier');
  assert.equal(next.product['agent.blocked_question'], 'Switch to other work');
  assert.equal(next.product['agent.close_asks'], false);
  assert.equal(next.product['agent.persistent_continuation'], true);
  const restored = JSON.parse(JSON.stringify(snapshot(next)));
  assert.equal(matchWorkingProfile(next, restored).matches, true);
  assert.equal(matchWorkingProfile(previous, restored).matches, false);
  restored.product.find(row => row.id === 'agent.persistent_continuation').value = false;
  assert.equal(matchWorkingProfile(previous, restored).matches, false);
});

test('the normal working-profile slider exposes Autonomous+ as its sixth named stop', async () => {
  const { createWorkingProfileSettings } = await import('../../src/settings-profile-settings.js');
  const control = createWorkingProfileSettings();
  const html = control.markup();
  assert.match(html, /data-working-profile-slider[^>]*max="5"/);
  assert.equal((html.match(/data-working-profile-choice=/g) || []).length, 6);
  assert.match(html, /data-working-profile-choice="autonomous-plus"[^>]*>Autonomous\+</);
});
