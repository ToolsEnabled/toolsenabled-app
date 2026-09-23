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
const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), '.settings-batch-'))
engine('./tests/lib/isolated-environment').configure(root)
process.env.TOOLSENABLED_SETTINGS_PATH = path.join(root, 'settings.json')
const file = process.env.TOOLSENABLED_SETTINGS_PATH
const settings = require('../../shell/product-settings.cjs')
const canonical = require('../../shell/canonical-audit.cjs')
const options = { root: engineRoot, fresh: true }
const initial = { revision: 9, values: { 'agent.agent_api': false,
  'outward.reserved_from_agents': ['Posting to social media', 'fixture reservation'], 'fixture.unrelated': 'preserved' },
  provenance: { 'agent.agent_api': { source: 'user', atMs: 1, directive: null },
    'outward.reserved_from_agents': { source: 'user', atMs: 1, directive: null } }, extra: { preserved: true } }
test.after(async () => {
  await canonical.closeCanonical()
  await engine('./src/lib/audit').close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('a batch validates and atomically applies one revision with legacy and reservation semantics preserved', () => {
  fs.writeFileSync(file, JSON.stringify(initial))
  const items = [{ id: 'agent.tool_mode', value: 'Native tools only' }, { id: 'tools.audit_batch_size', value: 16 },
    { id: 'tools.policy_enforcement', value: true }, { id: 'purchases.require_owner_approval', value: true }]
  const result = settings.setProductSettingsMany(items, options)
  assert.equal(result.ok, true, result.reason)
  assert.deepEqual(result.results.map(row => [row.id, row.value, row.revision]), items.map(row =>
    row.id === 'agent.tool_mode' ? ['agent.agent_api', 'Disabled', 10] : [row.id, row.value, 10]))
  assert.ok(result.results.every(row => row.provenance.source === 'user'))
  const stored = JSON.parse(fs.readFileSync(file))
  assert.deepEqual(stored.extra, initial.extra)
  assert.equal(stored.values['fixture.unrelated'], 'preserved')
  assert.equal(stored.values['agent.agent_api'], 'Disabled')
  assert.equal(stored.values['agent.tool_mode'], 'Native tools only')
  assert.deepEqual(stored.provenance['agent.agent_api'], stored.provenance['agent.tool_mode'])
  assert.deepEqual(stored.values['outward.reserved_from_agents'], ['Posting to social media', 'fixture reservation', 'Approving any purchase or spending any money'])
  assert.equal(fs.readdirSync(root).some(name => /candidate|\.tmp$/.test(name)), false)
})

test('invalid shape, unknown or duplicate IDs, purchase OFF and invalid later values change no active bytes', () => {
  const before = fs.readFileSync(file, 'utf8')
  for (const items of [[], null, [{ id: 'not.exposed', value: true }],
    [{ id: 'agent.agent_api', value: false }, { id: 'agent.tool_mode', value: 'Native tools only' }],
    [{ id: 'agent.agent_api', value: 'Enabled' }, { id: 'agent.tool_mode', value: 'ToolsEnabled and native tools' }],
    [{ id: 'agent.tool_summary', value: true }, { id: 'agent.tool_summary', value: false }],
    [{ id: 'agent.tool_summary', value: true }, { id: 'purchases.require_owner_approval', value: false }],
    [{ id: 'agent.tool_summary', value: false }, { id: 'model.endpoint', value: 'not a URL' }],
    [{ id: 'agent.tool_summary', value: false, confirmation: { code: '0000' } }]]) {
    const result = settings.setProductSettingsMany(items, options)
    assert.equal(result.ok, false)
    assert.deepEqual(result.results, [])
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  }
})

test('single, batch, legacy and default writes preserve all three choices with one visible canonical row', () => {
  const choices = [['Only', 'ToolsEnabled only'], ['Enabled', 'ToolsEnabled and native tools'], ['Disabled', 'Native tools only']]
  for (const writer of [item => settings.setProductSetting(item, options), item => settings.setProductSettingsMany([item], options)]) {
    for (const [canonical, alias] of choices) {
      for (const item of [{ id: 'agent.agent_api', value: canonical }, { id: 'agent.tool_mode', value: alias }]) {
        const previous = JSON.parse(fs.readFileSync(file))
        const result = writer(item)
        assert.equal(result.ok, true, result.reason)
        const saved = JSON.parse(fs.readFileSync(file))
        assert.equal(saved.revision, previous.revision + 1)
        assert.equal(saved.values['agent.agent_api'], canonical)
        assert.equal(saved.values['agent.tool_mode'], alias)
        assert.deepEqual(saved.provenance['agent.agent_api'], saved.provenance['agent.tool_mode'])
        const rows = settings.readProductSettings(options).rows
        assert.equal(rows.filter(row => row.id === 'agent.agent_api').length, 1)
        assert.equal(rows.some(row => row.id === 'agent.tool_mode'), false)
        assert.equal(rows.find(row => row.id === 'agent.agent_api').value, canonical)
      }
    }
    assert.equal(writer({ id: 'agent.agent_api', value: false }).ok, true)
    assert.equal(JSON.parse(fs.readFileSync(file)).values['agent.agent_api'], 'Enabled')
    assert.equal(writer({ id: 'agent.agent_api', value: 'Only' }).ok, true, 'reset to the registry default')
    const reset = JSON.parse(fs.readFileSync(file))
    assert.equal(reset.values['agent.tool_mode'], 'ToolsEnabled only', 'reset cannot resurrect the old Disabled alias')
    const before = fs.readFileSync(file, 'utf8')
    for (const item of [{ id: 'agent.agent_api', value: null }, { id: 'agent.tool_mode', value: 'invalid' }]) {
      assert.equal(writer(item).ok, false)
      assert.equal(fs.readFileSync(file, 'utf8'), before)
    }
  }
})

test('a concurrent settings edit during candidate validation is preserved and the batch is refused', () => {
  const original = fs.readFileSync(file, 'utf8')
  const concurrent = JSON.parse(original)
  concurrent.extra = { otherWriter: true }
  let changed = false
  const injected = { ...options, load(modulePath) {
    const loaded = require(modulePath)
    if (!modulePath.split(path.sep).join('/').endsWith(settings.SETTINGS_MODULE)) return loaded
    return { ...loaded, loadSettings(input) {
      const result = loaded.loadSettings(input)
      if (input?.valuesPath?.endsWith('.candidate') && !changed) {
        changed = true
        fs.writeFileSync(file, JSON.stringify(concurrent))
      }
      return result
    } }
  } }
  const result = settings.setProductSettingsMany([{ id: 'agent.tool_summary', value: false }], injected)
  assert.equal(changed, true)
  assert.equal(result.code, 'SETTINGS_CHANGED')
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), concurrent)
})

test('native canonical batch produces an ordered signed receipt for every settings event', async t => {
  const items = Array.from({ length: 30 }, (_, index) => ({ action: 'settings.set', target: `batch.fixture.${index}`,
    details: { value: index % 2 === 0, revision: 12 } }))
  const started = performance.now()
  const result = await canonical.recordCanonicalBatch(items, { stateRoot: process.env.TOOLSENABLED_STATE_ROOT, root: engineRoot })
  assert.equal(result.ok, true, result.reason || JSON.stringify(result.results))
  assert.equal(result.results.length, 30)
  assert.deepEqual(result.results.map(row => row.sequence), Array.from({ length: 30 }, (_, index) => index + 1))
  assert.ok(result.results.every(row => row.ok && /^[a-f0-9]{64}$/.test(row.eventHash)))
  const elapsedMs = Math.round(performance.now() - started)
  await canonical.closeCanonical()
  const audit = engine('./src/lib/audit')
  assert.equal(audit.verify().valid, true)
  const events = audit.tail(100)
  assert.equal(events.length, 30)
  assert.ok(events.every(row => row.action === 'settings.set'))
  assert.deepEqual(new Set(events.map(row => row.target)), new Set(items.map(row => row.target)))
  t.diagnostic(`${process.platform}: actual worker and native vault recorded 30 signed settings events in ${elapsedMs} ms.`)
})

test('a native batch cannot acknowledge signed receipts while audit maintenance holds the writer', async () => {
  await engine('./src/lib/audit').close()
  const guard = engine('./src/lib/audit-maintenance-guard')
  const lock = guard.lockPath(process.env.TOOLSENABLED_AUDIT_DB)
  fs.writeFileSync(lock, JSON.stringify({ fixture: 'maintenance owns the writer' }))
  try {
    const result = await canonical.recordCanonicalBatch([
      { action: 'settings.set', target: 'batch.refused.1' }, { action: 'settings.set', target: 'batch.refused.2' },
    ], { stateRoot: process.env.TOOLSENABLED_STATE_ROOT, root: engineRoot })
    assert.equal(result.ok, false)
    assert.equal(result.results.length, 2)
    assert.ok(result.results.every(row => row.ok === false && row.code === 'AUDIT_UNAVAILABLE'))
  } finally {
    await canonical.closeCanonical()
    fs.unlinkSync(lock)
  }
})

/* THE WORKING-PROFILE RECEIPT (owner, 2026-09-15: "my settings keep not
 * saving"). A Save that is also a profile application names the profile.
 * Without that record the page cannot tell a value the profile put there from
 * one the person picked afterwards, and re-picking the profile replays the
 * preset over their own later choice. */
test('a profile application records which profile applied it, and an ordinary save leaves it standing', () => {
  fs.writeFileSync(file, JSON.stringify(initial))
  const items = [{ id: 'audit.activity', value: 'Full' }, { id: 'agent.tool_summary', value: true }]
  const applied = settings.setProductSettingsMany({ items, workingProfile: 'autonomous-plus' }, options)
  assert.equal(applied.ok, true, applied.reason)
  const stored = JSON.parse(fs.readFileSync(file))
  assert.equal(stored.workingProfile.id, 'autonomous-plus')
  assert.equal(stored.workingProfile.atMs, stored.provenance['audit.activity'].atMs)
  assert.deepEqual(settings.readProductSettings(options).workingProfile, stored.workingProfile)
  assert.equal(stored.values['fixture.unrelated'], 'preserved', 'the receipt does not disturb the rest of the file')

  const later = settings.setProductSettingsMany([{ id: 'audit.activity', value: 'Off' }], options)
  assert.equal(later.ok, true, later.reason)
  const after = JSON.parse(fs.readFileSync(file))
  assert.deepEqual(after.workingProfile, stored.workingProfile, 'an ordinary save does not claim to be a profile application')
  assert.equal(after.values['audit.activity'], 'Off', 'and the person’s own value is what is stored')
})

test('a batch refuses an unnamed profile or an unknown companion key and changes no active bytes', () => {
  const before = fs.readFileSync(file, 'utf8')
  for (const request of [
    { items: [{ id: 'agent.tool_summary', value: false }], workingProfile: 'Not A Profile' },
    { items: [{ id: 'agent.tool_summary', value: false }], workingProfile: 5 },
    { items: [{ id: 'agent.tool_summary', value: false }], workingProfile: { id: 'balanced' } },
    { items: [{ id: 'agent.tool_summary', value: false }], workingProfile: 'balanced', owner: 'someone' },
  ]) {
    const result = settings.setProductSettingsMany(request, options)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SETTINGS_BATCH_INVALID')
    assert.deepEqual(result.results, [])
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  }
})

test('a receipt this build cannot vouch for reads as no receipt at all', () => {
  const document = JSON.parse(fs.readFileSync(file))
  for (const broken of [{ id: 'autonomous-plus' }, { id: 'autonomous-plus', atMs: 'soon' },
    { id: '', atMs: 5 }, 'autonomous-plus', null]) {
    fs.writeFileSync(file, JSON.stringify({ ...document, workingProfile: broken }))
    assert.equal(settings.readProductSettings(options).workingProfile, null)
  }
  fs.writeFileSync(file, JSON.stringify(document))
  assert.deepEqual(settings.readProductSettings(options).workingProfile, document.workingProfile)
})
