/* CHOOSING A WORKING PRESET APPLIES THE WHOLE PRESET (owner, 2026-09-16: "my
 * slider doesnt even work now for autonomous+. all the sliders are supposed to
 * be independent and make for a quick easy way to set the large majority of
 * settings. its literally just preset profiles").
 *
 * This file supersedes settings-profile-keeps-your-choices.test.mjs (2026-09-15),
 * which pinned the rule that a row the person had changed since the last
 * application was HELD BACK when a preset was chosen again. Measured on the
 * owner's own install: with every row carrying user provenance, choosing
 * Autonomous+ left most of the preset unstaged, the message said "N settings
 * you chose yourself are kept", and the slider read as broken. The receipt the
 * earlier change introduced stays, and does the honest half of that job: once
 * rows differ from the applied preset, the saved name reads "<preset> · N
 * changed" instead of forgetting the preset or claiming a match.
 *
 * Every row a preset names is staged through the row's own writer; the review
 * table shows each current value beside the preset's; Save settings applies
 * them all and records which preset chose them. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
installDomStandIn()
const { createWorkingProfileSettings } = await import('../../src/settings-profile-settings.js')
const { createSettingsDraft, draftSettingsBridge } = await import('../../src/settings-draft.js')
const { workingProfilePlan, WORKING_PROFILES } = await import('../../src/settings-profile-policy.js')
const { WRITE_ACTION_FLAGS } = await import('../../src/write-flags.js')

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const TIER = 'unrestricted'
const PROFILE = 'autonomous-plus'
const PROFILE_AT = 1_000_000
const planFor = id => workingProfilePlan(id, { tier: TIER, writeFlagIds: WRITE_ACTION_FLAGS.map(flag => flag.id), totalBytes: null })
// The saved values of an install that is on Autonomous+, as the preset wrote them.
const appliedValues = () => Object.fromEntries(Object.entries(planFor(PROFILE).product))

/* One Settings visit: the real draft, the real bridge and the real profile
 * controller over a shell that answers like the desktop one. */
function mount({ values = appliedValues(), receipt = { id: PROFILE, atMs: PROFILE_AT }, sources = {}, tier = TIER, resources: resourceStub = null } = {}) {
  const saved = { ...values }
  const batches = [], staged = []
  const shell = {
    read: async () => ({ ok: true, available: true, workingProfile: receipt,
      rows: Object.entries(saved).map(([id, value]) => ({ id, present: true, applicable: true, value,
        enforcement: { declared: true },
        provenance: { source: sources[id] || 'user', atMs: PROFILE_AT, directive: null } })) }),
    set: async (id, value) => { saved[id] = value; return { ok: true, id, value } },
    setMany: async (changes, options) => {
      batches.push({ ids: changes.map(change => change.id), workingProfile: options?.workingProfile ?? null })
      for (const change of changes) saved[change.id] = change.value
      return { ok: true, results: changes.map(change => ({ ok: true, id: change.id, value: change.value })) }
    },
  }
  const draft = createSettingsDraft()
  const productSettings = draftSettingsBridge(shell, draft)
  const plan = workingProfilePlan(PROFILE, { tier, writeFlagIds: WRITE_ACTION_FLAGS.map(flag => flag.id), totalBytes: null })
  const setup = {
    profileState: () => ({ tier, ready: true, errors: [], writeFlags: plan.setup.writeFlags, intent: plan.setup.intent, accounts: { applicable: false } }),
    readForProfile: async () => {},
    stageWorkingProfile: async plan => { staged.push(plan) },
  }
  const resources = resourceStub || {
    profileState: () => ({ applicable: false, ready: true, settings: {}, savedSettings: {}, totalBytes: null }),
    readForProfile: async () => {},
    stageForProfile: () => {},
  }
  const controller = createWorkingProfileSettings({ draft, productSettings, setup, resources })
  const root = document.createElement('div')
  root.innerHTML = `${controller.markup()}${controller.reviewMarkup()}`
  document.body.appendChild(root)
  controller.bind(root)
  return { root, draft, controller, batches, saved, staged }
}
const savedLabel = root => root.querySelector('[data-working-profile-current]').textContent
const messageOf = root => root.querySelector('[data-working-profile-message]').textContent
const reviewOf = root => root.querySelector('[data-working-profile-review]').textContent
const thumbOf = root => root.querySelector('[data-working-profile-slider]').value
const indexOf = id => String(WORKING_PROFILES.findIndex(profile => profile.id === id))

test('saved values that match no preset, with no receipt, do not read as Balanced', async () => {
  // T1438: a fresh copy read 'Saved: Custom' with the thumb on Balanced and
  // Balanced's 'keep approvals' sentence while approvals were off.
  const plans = WORKING_PROFILES.map(profile => planFor(profile.id).product)
  const shared = Object.keys(plans[0]).find(id => typeof plans[0][id] === 'boolean' && plans.every(product => product[id] === plans[0][id]))
  assert.ok(shared, 'a row every preset sets the same way')
  const { root, controller } = mount({ values: { ...appliedValues(), [shared]: !plans[0][shared] }, receipt: null })
  await settle(); await settle()
  const panel = root.querySelector('[data-working-profile]')
  const help = () => root.querySelector('[data-working-profile-help]').textContent
  assert.match(savedLabel(root), /Custom/)
  assert.equal(panel.dataset.profileState, 'custom', 'the thumb is drawn as a chosen stop')
  assert.match(help(), /No working profile is applied/)
  assert.notEqual(help(), planFor('balanced').description, 'Balanced\'s sentence describes a preset that is not in effect')
  assert.match(root.querySelector('[data-working-profile-slider]').getAttribute('aria-valuetext'), /No working profile is applied/)
  await controller.choose('careful'); await settle()
  assert.equal(panel.dataset.profileState, 'preset', 'a chosen preset is drawn as chosen')
  assert.equal(help(), planFor('careful').description)
})

test('choosing a preset stages every row it names, including one the person changed after it', async () => {
  // Their own "Refuse look-alikes", chosen after Autonomous+ was applied.
  // Choosing the preset again is a request for the preset, so the row is staged
  // back to "Allow code names" and nothing is reported as held back.
  const { root, draft, controller } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes' } })
  await settle()
  await controller.choose(PROFILE)
  assert.equal(draft.value('product:agent.message_screening'), 'Allow code names', 'the preset stages its own value over the later choice')
  assert.match(messageOf(root), /Profile values staged\. Review your pending choices, then Save settings\./)
  assert.doesNotMatch(messageOf(root), /kept as you set/)
  assert.doesNotMatch(reviewOf(root), /Kept because you chose/)
  assert.equal(root.querySelector('[data-working-profile-adopt]'), null, 'there is no second press to take the preset; the preset was taken')
})

test('a preset whose values are already saved has nothing to stage and says so', async () => {
  const { root, draft, controller } = mount()
  await settle()
  await controller.choose(PROFILE)
  assert.equal(draft.dirty, false, 'the saved values already are this preset')
  assert.match(messageOf(root), /Saved values already match Autonomous\+/)
})

test('another preset changes every row it declares, the person’s own included', async () => {
  const { root, draft, controller } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes' } })
  await settle()
  await controller.choose('balanced')
  assert.equal(draft.value('product:fleet.max_declared_agents'), 64, 'Balanced sets what it declares')
  assert.equal(draft.value('product:agent.message_screening'), 'Allow code names', 'and the row they changed goes with the preset')
  assert.match(messageOf(root), /Profile values staged/)
})

test('with no application recorded, a preset still stages every row it names', async () => {
  const { draft, controller } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes', 'fleet.max_declared_agents': 8 },
    receipt: null, sources: { 'agent.message_screening': 'user', 'fleet.max_declared_agents': 'default' } })
  await settle()
  await controller.choose(PROFILE)
  assert.equal(draft.value('product:agent.message_screening'), 'Allow code names', 'a row the person set is staged like any other')
  assert.equal(draft.value('product:fleet.max_declared_agents'), 512, 'a row nobody chose is staged like any other')
})

test('saving a staged preset names that preset on the write, with every row it set', async () => {
  const { draft, controller, batches } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes' } })
  await settle()
  await controller.choose('balanced')
  await draft.save()
  const receipted = batches.filter(batch => batch.workingProfile === 'balanced')
  assert.equal(receipted.length, 1, 'the preset rows are written together, under the preset that chose them')
  assert.ok(receipted[0].ids.includes('agent.message_screening'), 'the row it set over the person’s choice is one it claims')
  assert.ok(receipted[0].ids.includes('fleet.max_declared_agents'))
})

test('the review shows each current value beside the preset value and offers no held-back list', async () => {
  const { root, controller } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes' } })
  await settle()
  await controller.choose(PROFILE)
  const review = reviewOf(root)
  assert.match(review, /Choosing a profile stages every value in this table/)
  assert.match(review, /Allow code names/)
  assert.doesNotMatch(review, /would use/)
})

test('after the person changes a row, the saved name keeps the applied preset and counts the change', async () => {
  // "Custom" is what sent the owner back to the slider; "Autonomous+ · 1
  // changed" keeps the preset they chose in view, and the thumb stays on it.
  const { root } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes' } })
  await settle()
  assert.match(savedLabel(root), /Autonomous\+ · 1 changed/)
  assert.equal(thumbOf(root), indexOf(PROFILE), 'the slider thumb stays on the applied preset')
})

test('two changed rows count as two', async () => {
  const { root } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes', 'fleet.max_declared_agents': 64 } })
  await settle()
  assert.match(savedLabel(root), /Autonomous\+ · 2 changed/)
})

test('with no receipt and no exact match the saved name is Custom', async () => {
  const { root } = mount({ values: { ...appliedValues(), 'agent.message_screening': 'Refuse look-alikes' }, receipt: null, sources: { 'agent.message_screening': 'default' } })
  await settle()
  assert.match(savedLabel(root), /Custom/)
})

test('the answer-handling row goes through Setup with the preset’s own answer, never staged behind it', async () => {
  const { draft, controller, staged } = mount({ values: { ...appliedValues(), 'agent.blocked_question': 'Decide for itself' } })
  await settle()
  await controller.choose(PROFILE)
  assert.equal(draft.has('product:agent.blocked_question'), false, 'the row is never staged behind Setup')
  assert.equal(staged.at(-1)?.intent?.approvals, 'other-work', 'Setup is handed Autonomous+’s own answer')
})

test('a permission level that clamps the answer hands Setup the clamped one', async () => {
  const guided = workingProfilePlan(PROFILE, { tier: 'guided', writeFlagIds: WRITE_ACTION_FLAGS.map(flag => flag.id), totalBytes: null })
  assert.equal(guided.product['agent.blocked_question'], 'Stop and wait for me', 'the fixture only means anything if Guided clamps it')
  const { controller, staged } = mount({ tier: 'guided', values: { ...guided.product, 'agent.blocked_question': 'Decide for itself' } })
  await settle()
  await controller.choose(PROFILE)
  assert.equal(staged.at(-1)?.intent?.approvals, 'stop', 'Setup is handed the answer this level allows')
})

/* BASIC IS BASIC (owner direction 2026-09-20, T782). Detailed activity
   auditing is the person's own setup under Advanced; a preset never stages
   it, never counts a person's audit choice as a change, and says in the
   review that it is kept and where its setup lives. */
test('a preset leaves the person’s audit choice alone: not staged, not counted, named as kept', async () => {
  const { root, draft, controller, batches } = mount({ values: { ...appliedValues(), 'audit.activity': 'Off' } })
  await settle()
  assert.match(savedLabel(root), /Autonomous\+/)
  assert.doesNotMatch(savedLabel(root), /changed/, 'an audit choice is not a departure from the preset')
  await controller.choose(PROFILE)
  assert.equal(draft.has('product:audit.activity'), false, 'the preset does not stage the audit row')
  assert.match(messageOf(root), /Saved values already match Autonomous\+/)
  await controller.choose('balanced')
  assert.equal(draft.has('product:audit.activity'), false, 'nor does any other preset')
  assert.equal(draft.value('product:fleet.max_declared_agents'), 64, 'while the rows it does own are staged')
  const review = reviewOf(root)
  assert.match(review, /Keep your activity audit choice/)
  assert.match(review, /optional setup under Advanced/)
  assert.doesNotMatch(review, /mechanical resource checks enabled/, 'the review no longer promises enforced admission')
  await draft.save()
  for (const batch of batches) assert.ok(!batch.ids.includes('audit.activity'), 'no preset write ever carries the audit row')
})

/* THE ADMISSION MODE IS SHOWN, NOT JUST DESCRIBED (T782 review, Controller
   2026-09-21: resourceKept was computed but never interpolated). The kept list
   names the saved -- or pending -- admission mode beside the reason a profile
   leaves it alone, for every mode the host can report, through the real
   controller's paint. */
for (const mode of ['off', 'mechanical', 'controller', 'both']) test(`the review shows the saved admission mode (${mode}) beside its kept reason`, async () => {
  const resources = {
    profileState: () => ({ applicable: true, ready: true, settings: { mode, maxConcurrentStarts: 8 }, savedSettings: { mode, maxConcurrentStarts: 8 }, totalBytes: null }),
    readForProfile: async () => {},
    stageForProfile: () => {},
  }
  const { root } = mount({ resources })
  await settle()
  const review = reviewOf(root)
  assert.match(review, new RegExp(`Resource admission \\(now ${mode}\\):`), `the kept list names the ${mode} mode that is saved`)
  assert.match(review, /Keep your resource admission policy/, 'beside the reason a profile leaves it alone')
  assert.match(review, /never switches it on or off for you/)
})

test('the review shows a PENDING admission mode over the saved one, and reads Unavailable off a host that reports none', async () => {
  const resources = {
    profileState: () => ({ applicable: true, ready: true, settings: { mode: 'off', maxConcurrentStarts: 8 }, savedSettings: { mode: 'mechanical', maxConcurrentStarts: 8 }, totalBytes: null }),
    readForProfile: async () => {},
    stageForProfile: () => {},
  }
  const { root } = mount({ resources })
  await settle()
  assert.match(reviewOf(root), /Resource admission \(now off\):/, 'the person\'s pending All off is what the review names')
  assert.doesNotMatch(reviewOf(root), /\(now mechanical\)/)

  const silent = mount({ resources: { ...resources, profileState: () => ({ applicable: true, ready: true, settings: { maxConcurrentStarts: 8 }, savedSettings: { maxConcurrentStarts: 8 }, totalBytes: null }) } })
  await settle()
  assert.match(reviewOf(silent.root), /Resource admission \(now unavailable\):/, 'a host that reports no mode is read back as unavailable, never invented')

  const remote = mount()
  await settle()
  assert.match(reviewOf(remote.root), /<strong>Resource admission:<\/strong>|Resource admission:/, 'off the local desktop the reason is listed without a value')
  assert.doesNotMatch(reviewOf(remote.root), /\(now /)
})

for (const profile of ['independent', 'autonomous']) test(`${profile} stages and saves continuation through the visible preset without granting new access`, async () => {
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const base = workingProfilePlan(PROFILE, { tier, writeFlagIds: WRITE_ACTION_FLAGS.map(flag => flag.id), totalBytes: null })
    const { root, draft, controller, batches, saved, staged } = mount({
      tier, values: { ...base.product, 'agent.persistent_continuation': false,
        'audit.enabled': false, 'agent.agent_api': 'Only', 'research.pipeline': false },
    })
    try {
      await settle()
      assert.equal(batches.length, 0, 'opening Settings does not write a preset')
      const button = root.querySelector(`[data-working-profile-choice="${profile}"]`)
      assert.equal(button.disabled, false)
      button.click()
      await settle()
      assert.equal(draft.value('product:agent.persistent_continuation'), true, `${tier}/${profile} stages continuation`)
      assert.equal(saved['agent.persistent_continuation'], false, 'the visible choice is still pending before Save')
      assert.match(messageOf(root), /Profile values staged/)
      assert.equal(staged.at(-1).intent.approvals, tier === 'guided' ? 'stop' : 'judgement')
      await draft.save()
      assert.equal(draft.dirty, false)
      assert.equal(saved['agent.persistent_continuation'], true, 'Save commits the continuation choice')
      const receipt = batches.filter(batch => batch.workingProfile === profile)
      assert.equal(receipt.length, 1)
      assert.ok(receipt[0].ids.includes('agent.persistent_continuation'))
      assert.equal(saved['purchases.require_owner_approval'], true)
      assert.equal(saved['capability.elevation_survives_restart'], false)
      assert.equal(saved['agent.tool_approvals'], tier === 'guided')
      for (const id of ['audit.enabled', 'agent.agent_api', 'research.pipeline']) {
        assert.equal(receipt[0].ids.includes(id), false, `${id} remains a separate choice`)
      }
      assert.equal(saved['audit.enabled'], false)
      assert.equal(saved['agent.agent_api'], 'Only')
      assert.equal(saved['research.pipeline'], false)
    } finally { controller.destroy(); root.remove() }
  }
})

test('restraint presets still stage continuation off through the same draft and save path', async () => {
  for (const profile of ['locked', 'careful', 'balanced']) {
    const { root, draft, controller, saved } = mount()
    try {
      await settle()
      root.querySelector(`[data-working-profile-choice="${profile}"]`).click()
      await settle()
      assert.equal(draft.value('product:agent.persistent_continuation'), false)
      assert.equal(saved['agent.persistent_continuation'], true, 'the saved choice waits for Save')
      await draft.save()
      assert.equal(saved['agent.persistent_continuation'], false)
    } finally { controller.destroy(); root.remove() }
  }
})
