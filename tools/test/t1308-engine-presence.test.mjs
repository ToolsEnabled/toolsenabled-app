import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { tierProviderWord } from '../../src/fleet-tree-copy.js'
import { mountComputers, settle } from './helpers/t1308-computers-fixture.mjs'

const providers = [...new Set(LAUNCH_TIERS.map(row => row.provider))]
const tiers = LAUNCH_TIERS.map(row => row.id)
const wordsFor = ids => [...new Set(LAUNCH_TIERS.filter(row => ids.includes(row.provider)).map(row => tierProviderWord(row.id)))]
const presence = values => ({ ok: true, providers: providers.filter(id => id !== 'local').map(id => ({
  id, installed: values[id] ?? 'no', signedIn: 'unknown',
})) })
const face = fixture => {
  const setup = fixture.view.el.querySelector('[data-tree-move]')
  assert.ok(setup, 'real node Setup section mounted')
  const label = setup.querySelector('.ctl-row .cv')
  const note = setup.querySelector('.board-absent-copy')
  assert.ok(label); assert.ok(note)
  return { label, note }
}
function assertProviders(fixture, wanted) {
  const actual = face(fixture)
  const expected = wordsFor(wanted)
  assert.equal(actual.label.textContent, expected.length ? expected.join(' · ') : 'nothing yet')
  for (const word of wordsFor(providers)) {
    assert.equal(actual.note.textContent.includes(word), expected.includes(word), 'Engine note inclusion: ' + word)
  }
}
const fixtures = [
  ['no startable tiers', presence(Object.fromEntries(providers.map(id => [id, 'yes']))), [], []],
  ['no installed providers', presence({}), ['local'], tiers],
  ['all installed providers', presence(Object.fromEntries(providers.map(id => [id, 'yes']))), providers, tiers],
  ['partial installed providers', presence({ claude: 'yes', codex: 'unknown' }), ['claude', 'local'], tiers],
  ['unknown presence', null, ['local'], tiers],
  ['installed provider without a startable tier', presence({ codex: 'yes', claude: 'yes' }), ['codex'], LAUNCH_TIERS.filter(row => row.provider === 'codex').map(row => row.id)],
]
for (const [name, reply, expected, available] of fixtures) {
  test('mounted Engine intersects installed and startable providers: ' + name, async t => {
    const fixture = await mountComputers(t, { nodes: [{ id: 'node-engine' }], tiers: available, presence: reply })
    await fixture.openNode('node-engine')
    assertProviders(fixture, expected)
    assert.deepEqual(fixture.operations, [])
  })
}

test('mounted Engine distinguishes unknown installation from known no available provider', async t => {
  for (const [reply, label] of [[null, 'not answered'], [presence({}), 'nothing yet']]) await t.test(label, async child => {
    const available = LAUNCH_TIERS.filter(row => row.provider !== 'local').map(row => row.id)
    const fixture = await mountComputers(child, { nodes: [{ id: 'node-engine' }], tiers: available, presence: reply })
    await fixture.openNode('node-engine')
    assert.equal(face(fixture).label.textContent, label)
    assert.ok(face(fixture).note.textContent.length)
    assert.deepEqual(fixture.operations, [])
  })
})

test('an existing provider refresh updates mounted Engine label and note without rebuilding the rail', async t => {
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-engine' }], tiers, presence: null, holdPresence: true })
  await fixture.openNode('node-engine')
  const initial = face(fixture)
  assertProviders(fixture, ['local'])
  fixture.resolvePresence(presence({ codex: 'yes' }))
  await settle()
  assertProviders(fixture, ['codex', 'local'])
  assert.equal(face(fixture).label, initial.label)
  assert.equal(face(fixture).note, initial.note)
  for (const [reply, expected] of [
    [presence({ claude: 'yes' }), ['claude', 'local']],
    [new Error('presence unavailable'), ['local']],
    [presence({}), ['local']],
  ]) {
    const before = fixture.readings.presence
    await fixture.refreshPresence(reply)
    assert.equal(fixture.readings.presence, before + 1, 'one existing compose-open read')
    assertProviders(fixture, expected)
    assert.equal(face(fixture).label, initial.label)
    assert.equal(face(fixture).note, initial.note)
  }
  assert.deepEqual(fixture.operations, [])
})
