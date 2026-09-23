import test from 'node:test'
import assert from 'node:assert/strict'
import { planManagedSlotChoice } from '../../src/managed-slot-choice.js'
const tiers = [
  { id: 'model-a', model: 'provider-one-model-a', provider: 'one', effort: 'medium' },
  { id: 'model-b', model: 'provider-one-model-b', provider: 'one', effort: 'high' },
  { id: 'model-c', model: 'provider-two-model-c', provider: 'two', effort: 'low' },
  { id: 'model-local', provider: 'local', effort: null },
]
const current = { tier: 'model-a', provider: 'one', effort: 'medium', account: 'same-name', role: 'worker' }
const fixture = extra => ({ current, tiers, startable: tiers.map(row => row.id), answered: true,
  accounts: [{ name: 'same-name', provider: 'one' }, { name: 'same-name', provider: 'two' },
    { name: 'another', provider: 'one', signedIn: true }, { name: 'out', provider: 'one', signedIn: false }],
  accountAnswered: true, efforts: ['low', 'medium', 'high'], effortAnswered: true,
  roles: [{ id: 'worker' }, { id: 'custom-manager', functions: [] }], ...extra })
const plan = (field, value, extra) => planManagedSlotChoice(fixture({ action: 'set-node-' + field, value, ...extra }))
test('managed model choices resolve catalog identifiers and model names on only the current provider', () => {
  for (const value of ['model-b', 'provider-one-model-b']) {
    const result = plan('model', value)
    assert.equal(result.ok, true)
    assert.equal(result.choice.tier, 'model-b')
    assert.equal(result.choice.provider, 'one')
    assert.equal(result.choice.account, 'same-name')
    assert.deepEqual(result.previous, current)
  }
  for (const value of ['model-c', 'not-a-model']) assert.equal(plan('model', value).ok, false)
  assert.deepEqual(current, { tier: 'model-a', provider: 'one', effort: 'medium', account: 'same-name', role: 'worker' })
})
test('unanswered and explicit unavailable model catalogs refuse changes without changing current values', () => {
  for (const extra of [{ answered: false }, { startable: null }, { startable: [] }]) {
    const result = plan('model', 'model-b', extra)
    assert.equal(result.ok, false)
    assert.ok(result.reason)
  }
  assert.equal(plan('model', 'model-a', { answered: false }).changed, false, 'keeping the applied model needs no new admission')
})
test('provider changes use the first supported catalog choice and drop provider-local account/effort assumptions', () => {
  const result = plan('provider', 'two')
  assert.equal(result.ok, true)
  assert.deepEqual(result.choice, { tier: 'model-c', provider: 'two', effort: 'low', account: null, role: 'worker' })
  assert.deepEqual(result.previous, current)
  assert.equal(plan('provider', 'two', { startable: ['model-a', 'model-b'] }).ok, false)
  assert.equal(plan('provider', 'not-a-provider').ok, false)
})
test('effort is chosen from the actual model list with explicit unknown/unsupported refusal', () => {
  assert.equal(plan('effort', 'high').choice.effort, 'high')
  assert.equal(plan('effort', 'maximum').ok, false)
  assert.equal(plan('effort', 'high', { effortAnswered: false }).ok, false)
  assert.equal(plan('effort', 'high', { efforts: [] }).ok, false)
  assert.equal(plan('effort', 'medium', { effortAnswered: false }).changed, false)
})
test('account choices stay with the current provider and refuse signed-out, unknown or local accounts', () => {
  assert.equal(plan('account', 'another').choice.account, 'another')
  assert.equal(plan('account', 'out').ok, false)
  assert.equal(plan('account', 'missing').ok, false)
  assert.equal(plan('account', 'another', { accountAnswered: false }).ok, false)
  assert.equal(plan('account', 'another', { accounts: [{ name: 'another', provider: 'two' }] }).ok, false)
  assert.equal(plan('account', 'another', { current: { ...current, tier: 'model-local', provider: 'local' } }).ok, false)
})
test('role selection keeps custom role identifiers without granting or enabling anything', () => {
  const args = fixture({ action: 'set-node-role', value: 'custom-manager' }), before = structuredClone(args)
  const result = planManagedSlotChoice(args)
  assert.equal(result.ok, true)
  assert.equal(result.choice.role, 'custom-manager')
  assert.deepEqual(args, before)
  assert.equal(plan('role', 'missing').ok, false)
})
test('ambiguous model aliases, malformed requests and inconsistent applied identities refuse by name', () => {
  assert.equal(plan('model', 'provider-one-model-b', { tiers: [...tiers, { ...tiers[1], id: 'ambiguous' }] }).ok, false)
  for (const [field, value] of [['enable-agent', 'yes'], ['constructor', 'worker'], ['model', ''], ['effort', 42], ['role', '\u0000']]) {
    const result = plan(field, value)
    assert.equal(result.ok, false)
    assert.ok(result.code && result.reason)
  }
  for (const action of ['constructor', 'toString']) assert.equal(planManagedSlotChoice(fixture({ action, value: 'worker' })).ok, false)
  assert.equal(plan('provider', 'two', { current: { ...current, provider: 'wrong' } }).ok, false)
})
