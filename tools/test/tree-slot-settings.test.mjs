import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { sectionOfRow } from '../../src/product-settings-layout.js'
import { createResearchSettings } from '../../src/research-settings.js'
import { createTreeSlotAdmission } from '../../shell/tree-slot-admission.cjs'
import * as policy from '../../shell/tree-slot-policy.mjs'
import { parseFleetTrees } from '../../src/fleet-trees.js'
const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests()
const shell = require('../../shell/product-settings.cjs')
const engineSettings = require(path.join(engineRoot, 'src/lib/settings.js'))
const registryModule = require(path.join(engineRoot, 'src/lib/settings-registry.js'))
const modes = require(path.join(engineRoot, 'src/lib/agent-api-mode.js'))
const ids = ['fleet.tree_width', 'fleet.tree_depth', 'fleet.max_declared_agents']

// The real shell writer and engine reader use this one synthetic in-memory
// filesystem. No fixture is created, replaced or deleted on the host.
function fixture(t) {
  const prefix = path.join(process.env.TMPDIR, 'memory-only-slot-settings-' + randomUUID())
  const valuesPath = path.join(prefix, 'settings.json'), files = new Map()
  const real = Object.fromEntries(['readFileSync', 'writeFileSync', 'mkdirSync', 'renameSync', 'rmSync'].map(name => [name, fs[name]]))
  const isFixture = value => typeof value === 'string' && (value === prefix || value.startsWith(prefix + path.sep))
  const missing = () => Object.assign(new Error('Synthetic fixture file is absent'), { code: 'ENOENT' })
  fs.readFileSync = (file, ...rest) => {
    if (!isFixture(file)) return real.readFileSync(file, ...rest)
    if (!files.has(file)) throw missing()
    return files.get(file)
  }
  fs.writeFileSync = (file, text) => { assert.ok(isFixture(file), 'writes stay in the memory fixture'); files.set(file, String(text)) }
  fs.mkdirSync = file => { assert.ok(isFixture(file), 'directory writes stay in the memory fixture') }
  fs.renameSync = (from, to) => {
    assert.ok(isFixture(from) && isFixture(to), 'renames stay in the memory fixture')
    if (!files.has(from)) throw missing()
    files.set(to, files.get(from)); files.delete(from)
  }
  fs.rmSync = file => { assert.ok(isFixture(file), 'cleanup is only a memory-map operation'); files.delete(file) }
  t.after(() => { for (const [name, fn] of Object.entries(real)) fs[name] = fn; shell.resetForTests() })
  const completeRegistry = registryModule.loadRegistry()
  const entries = completeRegistry.entries.filter(entry => ids.includes(entry.id))
  assert.equal(entries.length, ids.length, 'all three settings must exist in the actual engine registry')
  const registry = { ...completeRegistry, entries, byId: new Map(entries.map(entry => [entry.id, entry])) }
  const settings = { resolveValuesPath: () => valuesPath,
    loadSettings: options => engineSettings.loadSettings({ ...options, valuesPath: options.valuesPath ?? valuesPath }) }
  const options = { root: engineRoot, fresh: true, load: filename =>
    filename.endsWith('agent-api-mode.js') ? modes : filename.endsWith('settings-registry.js')
      ? { loadRegistry: () => registry } : settings }
  return { options, registry, valuesPath, files, read: () => shell.readTreeSlotSettings(options),
    saved: () => JSON.parse(files.get(valuesPath)),
    seed(document) { files.set(valuesPath, typeof document === 'string' ? document : JSON.stringify(document)) } }
}
test('actual settings writer and reader persist width/depth independently of the org aggregate', t => {
  const f = fixture(t)
  assert.deepEqual(f.read().bounds, { maxChildren: 4, maxDepth: 3 })
  const result = shell.setProductSettingsMany([
    { id: ids[0], value: 2 }, { id: ids[1], value: 1 }, { id: ids[2], value: 123 },
  ], f.options)
  assert.equal(result.ok, true)
  assert.deepEqual(f.read().bounds, { maxChildren: 2, maxDepth: 1 })
  assert.equal(f.saved().values[ids[2]], 123)
  assert.equal(f.read().provenance[ids[0]].source, 'user')
  assert.equal(f.read().provenance[ids[1]].source, 'user')
  assert.equal(f.read().revision, result.results[0].revision)
  assert.equal(shell.setProductSetting({ id: ids[0], value: 6 }, f.options).ok, true)
  assert.deepEqual(f.read().bounds, { maxChildren: 6, maxDepth: 1 })
  assert.equal(f.saved().values[ids[2]], 123)
})
test('invalid width/depth choices refuse and preserve the complete prior settings', t => {
  const f = fixture(t)
  assert.equal(shell.setProductSettingsMany([{ id: ids[0], value: 3 }, { id: ids[1], value: 2 }], f.options).ok, true)
  const before = f.files.get(f.valuesPath)
  for (const [id, value] of [[ids[0],0], [ids[0],65], [ids[0],2.5], [ids[1],-1], [ids[1],17], [ids[1],'2']]) {
    const reply = shell.setProductSetting({ id, value }, f.options)
    assert.equal(reply.ok, false, id + ' must refuse ' + JSON.stringify(value))
    assert.equal(reply.code, 'SETTING_VALUE_REFUSED')
    assert.equal(f.files.get(f.valuesPath), before)
  }
})
test('unreadable or invalid saved bounds refuse new native admission instead of granting defaults', t => {
  const f = fixture(t)
  const forest = { trees: [{ id: 'tree', kind: 'ordinary' }],
    nodes: [{ id: 'parent', treeId: 'tree', parentId: null, sessionId: 'parent-session' }] }
  const admission = createTreeSlotAdmission({ readBounds: f.read, readForest: () => forest, policy, parseRecord: parseFleetTrees, makeId: randomUUID })
  for (const document of ['{broken', { revision: 1, values: { [ids[0]]: 0 } },
    { revision: 2, values: { [ids[1]]: 1.5 } }]) {
    f.seed(document)
    assert.equal(f.read().ok, false)
    assert.throws(() => admission.reserve({ computerId: 'fixture', parentSessionId: 'parent-session' }),
      { code: 'TREE_SLOT_SETTINGS_UNAVAILABLE' })
  }
})
test('settings changes take effect at the next authoritative reservation without changing saved nodes', t => {
  const f = fixture(t)
  const forest = { trees: [{ id: 'tree', kind: 'ordinary' }],
    nodes: [{ id: 'parent', treeId: 'tree', parentId: null, sessionId: 'parent-session' },
      { id: 'old-child', treeId: 'tree', parentId: 'parent', status: 'stopped' }] }
  const before = structuredClone(forest)
  const admission = createTreeSlotAdmission({ readBounds: f.read, readForest: () => forest, policy, parseRecord: parseFleetTrees, makeId: randomUUID })
  assert.equal(shell.setProductSetting({ id: ids[0], value: 1 }, f.options).ok, true)
  assert.throws(() => admission.reserve({ computerId: 'fixture', parentSessionId: 'parent-session' }), { code: 'TREE_SLOT_LIMIT' })
  assert.equal(shell.setProductSetting({ id: ids[0], value: 2 }, f.options).ok, true)
  const slot = admission.reserve({ computerId: 'fixture', parentSessionId: 'parent-session' })
  assert.equal(slot.parentId, 'parent')
  slot.release()
  assert.equal(shell.setProductSetting({ id: ids[1], value: 0 }, f.options).ok, true)
  assert.throws(() => admission.reserve({ computerId: 'fixture', parentSessionId: 'parent-session' }), { code: 'TREE_SLOT_LIMIT', message: /delegation depth/ })
  assert.deepEqual(forest, before, 'lowering a bound preserves every existing record')
})
for (const id of ids.slice(0, 2)) test(id + ' shows a warning while changed and removes it when reverted', async t => {
  const f = fixture(t), response = shell.readProductSettings(f.options)
  const row = response.rows.find(row => row.id === id)
  assert.equal(row.present, true)
  assert.ok(row.warningText?.trim())
  const warning = { hidden: true }, article = { dataset: {},
    querySelector: selector => selector === '[data-setting-change-warning]' ? warning : null }
  const root = { addEventListener() {}, removeEventListener() {},
    querySelectorAll: selector => selector.includes(id) ? [article] : [] }
  const page = createResearchSettings({ shell: { stagesWrites: true, read: async () => response,
    set: async (_id, value) => ({ ok: true, draft: true, pending: value !== row.default }) } })
  t.after(() => page.destroy())
  page.bind(root); await page.load()
  const initialMarkup = page.markup({ section: sectionOfRow(id) })
  assert.ok(initialMarkup.includes(row.warningText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')))
  await page.setValue(id, row.default + 1, { live: true })
  assert.equal(warning.hidden, false)
  assert.equal(article.dataset.settingPending, 'true')
  assert.equal(f.files.has(f.valuesPath), false, 'staging the warning does not save or apply a bound')
  await page.setValue(id, row.default, { live: true })
  assert.equal(warning.hidden, true)
  assert.equal(article.dataset.settingPending, 'false')
})
