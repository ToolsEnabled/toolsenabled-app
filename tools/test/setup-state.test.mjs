import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_TIER,
  SETUP_RESOLUTION,
  TIER_CHOICES,
  TIER_IDS,
  TIER_LIMIT_LEAD,
  TIER_LIMIT_NOTICE,
  TIER_QUESTION,
  TIER_QUESTION_SUB,
  WORKSPACE_ACCESS_NOTICE,
  firstRunPending,
  noteTierRecorded,
  readSetupState,
  shouldOpenSetup,
} from '../../src/setup-state.js'

const bridge = bootstrap => ({
  mcSetup: { bootstrap, chooseTier() {} },
})

test('permission choices expose the safe default, stable identifiers, and consequences', () => {
  assert.deepEqual(TIER_IDS, ['guided', 'standard', 'unrestricted'], 'tiers must progress from guided to unrestricted')
  assert.equal(DEFAULT_TIER, 'standard', 'fresh Basic setup recommends ordinary project actions')
  assert.ok(Object.isFrozen(TIER_CHOICES) && TIER_CHOICES.every(Object.isFrozen), 'tier definitions must be immutable shared product data')
  assert.match(TIER_CHOICES[0].detail, /one folder/i, 'guided copy must explain its starting folder')
  assert.match(TIER_CHOICES[0].detail, /requests read-only/i, 'a requested write policy must not be presented as a measured read boundary')
  for (const choice of TIER_CHOICES.slice(0, 2)) assert.match(choice.detail, /elsewhere.*readable/i, 'narrower tiers must disclose broader possible reads')
  assert.match(TIER_CHOICES[2].detail, /read.*change.*delete.*any file/is, 'unrestricted copy must disclose broad file access')
})

test('the question and limitation copy communicate choice, reversibility, enforcement, and scope', () => {
  assert.match(TIER_QUESTION, /allowed/i, 'the heading must ask about permission')
  assert.match(TIER_QUESTION_SUB, /change.*later.*settings/i, 'the question must say the choice can be changed later')
  assert.match(TIER_LIMIT_LEAD, /not pretend/i, 'the limitation lead must frame the disclosure honestly')
  const notice = TIER_LIMIT_NOTICE.join(' ')
  assert.match(notice, /requested write policy/i, 'the notice must distinguish requested permissions from effective enforcement')
  assert.match(notice, /can still read files elsewhere/i, 'write restrictions do not establish a read boundary')
  assert.match(notice, /session.*reported permissions/i, 'a requested policy is not a measured enforcement receipt')
  assert.match(WORKSPACE_ACCESS_NOTICE, /requested.*write policy.*read files elsewhere/i)
  assert.doesNotMatch([notice, WORKSPACE_ACCESS_NOTICE, ...TIER_CHOICES.map(choice => choice.detail)].join(' '), /cannot reach (anything else|the rest)|everything outside.*off limits/i)
  assert.match(notice, /another program/i, 'the notice must distinguish sessions still run by another program')
  assert.match(notice, /already did/i, 'the notice must say a new level cannot undo earlier work')
})

test('readSetupState normalizes the bootstrap shapes supplied by shell callers', () => {
  const fresh = readSetupState(bridge({ ok: true, available: true, configured: false, tier: null }))
  assert.deepEqual(fresh, { available: true, configured: false, tier: null, code: null, reason: null }, 'a writable fresh install must remain eligible for setup')

  const configured = readSetupState(bridge({ ok: true, available: true, configured: true, tier: 'standard' }))
  assert.deepEqual(configured, { available: true, configured: true, tier: 'standard', code: null, reason: null }, 'a known recorded tier must remain configured')

  const unknown = readSetupState(bridge({ ok: true, available: true, configured: true, tier: 'future-tier' }))
  assert.equal(unknown.configured, false, 'an unknown tier must not count as a definite configured answer')
  assert.equal(unknown.tier, null, 'an unknown tier must be represented as unknown')
})

test('missing, unusable, and unreadable bootstrap results never become definite answers', () => {
  for (const bootstrap of [undefined, null, [], 'bad reply']) {
    const state = readSetupState(bridge(bootstrap))
    assert.equal(state.available, false, `an unusable ${JSON.stringify(bootstrap)} reply must fail closed`)
    assert.equal(state.configured, false, `an unusable ${JSON.stringify(bootstrap)} reply must not claim configuration`)
  }

  const refused = readSetupState(bridge({ ok: false, code: 'READ_FAILED', reason: 'disk could not be read' }))
  assert.equal(refused.code, 'READ_FAILED', 'a shell read failure must preserve its diagnostic code')
  assert.match(refused.reason, /could not be read/i, 'a shell read failure must preserve its useful reason')

  const unreadable = readSetupState(bridge({ ok: true, unreadable: true }))
  assert.equal(unreadable.available, false, 'an unreadable existing record must not be offered as writable setup')
  assert.equal(unreadable.configured, false, 'an unreadable record must not collapse into a configured answer')
  assert.match(unreadable.reason, /already has a configuration.*could not be read/i, 'the unreadable-record refusal must explain both existence and read failure')
})

test('fallback refusals identify whether setup is absent locally or unknown remotely', () => {
  const browser = readSetupState({})
  assert.equal(browser.code, 'MC_SETUP_SHELL_ABSENT', 'a browser must report the absent installed bridge')
  assert.match(browser.reason, /browser.*no computer.*configure/i, 'the browser refusal must explain why setup is unavailable')

  const local = readSetupState({ mcSetup: { chooseTier() {} }, mcShell: { getBridgeProof() {} } })
  assert.match(local.reason, /this computer.*set up/i, 'a proved desktop must describe its local computer')

  const relayed = readSetupState({ mcSetup: { chooseTier() {} } })
  assert.match(relayed.reason, /computer you are driving.*set up/i, 'a relay must not claim the remote computer is local')
})

test('first-run routing opens only a writable unanswered setup and never loops', () => {
  const pending = readSetupState(bridge({ ok: true, available: true, configured: false, tier: null }))
  assert.equal(firstRunPending(pending), true, 'a writable unanswered state must be pending')
  assert.equal(shouldOpenSetup(pending, 'home'), true, 'a pending launch must redirect from a product route')
  assert.equal(shouldOpenSetup(pending, 'setup'), false, 'the setup route must not redirect to itself')

  assert.equal(firstRunPending(readSetupState({})), false, 'an unavailable setup must fail open instead of trapping the user')
  assert.equal(firstRunPending(readSetupState(bridge({ configured: true, tier: 'guided' }))), false, 'a recorded known tier must end first-run setup')
})

test('noteTierRecorded updates the shared resolution only for real caller tier ids', () => {
  const before = { configured: SETUP_RESOLUTION.configured, tier: SETUP_RESOLUTION.tier }
  const accepted = noteTierRecorded('standard')
  assert.equal(accepted, SETUP_RESOLUTION, 'recording must update the shared resolution object callers retain')
  assert.equal(SETUP_RESOLUTION.configured, true, 'recording a known tier must end the setup gate immediately')
  assert.equal(SETUP_RESOLUTION.tier, 'standard', 'recording must expose the newly selected tier')

  noteTierRecorded('future-tier')
  assert.equal(SETUP_RESOLUTION.tier, 'standard', 'an unknown tier must not overwrite the last recorded tier')

  SETUP_RESOLUTION.configured = before.configured
  SETUP_RESOLUTION.tier = before.tier
})


test('fresh Basic setup recommends Standard while saved and unknown access remain distinct', async () => {
  const { deriveProfile, RECOMMENDED_ANSWERS, SAFE_ANSWERS, applyProfile } = await import('../../src/setup-profile.js');
  const { WRITE_ACTION_FLAGS } = await import('../../src/write-flags.js');
  const ids = WRITE_ACTION_FLAGS.map(row => row.id);
  assert.equal(DEFAULT_TIER, 'standard');
  for (const answers of [RECOMMENDED_ANSWERS, SAFE_ANSWERS]) {
    const plan = deriveProfile(answers, { tier: DEFAULT_TIER, writeFlagIds: ids });
    const saved = new Map();
    applyProfile(plan, { setWriteFlag: (key, value) => saved.set(key, value), setExampleMode() {} });
    assert.equal(plan.intent.approvals, 'judgement');
    assert.equal(saved.size, ids.length);
    for (const id of ids) assert.equal(saved.get(id), true, id);
  }
  for (const tier of TIER_IDS) {
    const state = readSetupState(bridge({ ok: true, available: true, configured: true, tier }));
    assert.equal(state.tier, tier);
    assert.equal(firstRunPending(state), false);
  }
  for (const bootstrap of [{ configured: true, tier: 'future-tier' }, { configured: true, tier: null }, { available: true }, { configured: false, tier: 'future-tier' }, { unreadable: true }]) {
    const state = readSetupState(bridge({ ok: true, ...bootstrap }));
    assert.equal(state.available, false, JSON.stringify(bootstrap));
    assert.equal(firstRunPending(state), false);
  }
});
