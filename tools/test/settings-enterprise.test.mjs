import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { ENTERPRISE_SECTION, ENTERPRISE_SETTING_IDS } from '../../src/enterprise-settings.js'
import { createResearchSettings } from '../../src/research-settings.js'
import { createSettingsDraft, draftSettingsBridge } from '../../src/settings-draft.js'

const engineRoot = ownedFixtureTempRoot({ selected: canonicalRootForTests() })
const require = createRequire(import.meta.url)
const engine = createRequire(path.join(engineRoot, 'package.json'))
const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'enterprise-settings-'))
// The Engine source carries its isolation helper; a packed capability layer
// deliberately ships no tests/. The Linux cut gate runs this suite against both,
// so the packed run fences the same profile roots by hand, the way
// audit-performance-settings.test.mjs does.
if (fs.existsSync(path.join(engineRoot, 'tests/lib/isolated-environment.js'))) engine('./tests/lib/isolated-environment').configure(root)
else for (const name of ['TOOLSENABLED_STATE_ROOT', 'LOCALAPPDATA', 'APPDATA']) process.env[name] = root
process.env.TOOLSENABLED_SETTINGS_PATH = path.join(root, 'settings.json')
const settings = require('../../shell/product-settings.cjs')
const options = { root: engineRoot, fresh: true }
const initial = { revision: 11, values: {
  'agent.agent_api': false, 'agent.tool_mode': 'ToolsEnabled and native tools',
  'agent.subagent_route': 'Never on your tree', 'agent.tool_approvals': false,
  'purchases.require_owner_approval': false,
  'fleet.max_declared_agents': 64, 'tools.throughput': 'fast',
}, provenance: {} }
for (const id of Object.keys(initial.values)) initial.provenance[id] = { source: 'user', atMs: 10, directive: null }
const reset = () => fs.writeFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, JSON.stringify(initial))
const read = () => settings.readProductSettings(options)
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('Enterprise reads the real installation controls without changing any saved bytes', async () => {
  reset()
  const before = fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8')
  const controller = createResearchSettings({ shell: { read, set: () => assert.fail('viewing cannot write') } })
  await controller.load()
  const html = controller.markup({ section: ENTERPRISE_SECTION })
  const shown = [...html.matchAll(/data-research-setting-row="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(shown, ENTERPRISE_SETTING_IDS)
  assert.equal(new Set(shown).size, shown.length)
  assert.doesNotMatch(html, /data-research-setting-row="(?:agent\.agent_api|agent\.tool_mode|agent\.subagent_route)"/)
  assert.match(html, /other computers|Other computers/)
  assert.match(html, /In Fast mode/)
  assert.match(html, /not a running-agent or company-wide quota/)
  assert.match(html, /applies only while Signed activity audit is on/)
  assert.match(html, /write failures can leave gaps even in Full/)
  // Master-off is scoped to new operations: admitted audited
  // operations may still finish recording across a toggle (root 2026-09-21).
  assert.match(html, /With that off, the choice is kept for later and new operations do not request audit records\. Work already underway may finish recording/)
  assert.doesNotMatch(html, /the choice is kept and (?:nothing is written|no new records are written)/)
  // Throughput mode chooses how calls are processed; what it retains is
  // conditional on the audit master, never unconditional, and likewise scoped
  // to new operations with the master off.
  assert.match(html, /While Signed activity audit is on, both retain the required security audit and Tool activity audit selects completion summaries\. With Signed activity audit off, neither mode requests audit records for new operations\. Work already underway may finish recording/)
  assert.doesNotMatch(html, /neither mode writes audit records/)
  assert.doesNotMatch(html, /Both retain required security audit/)
  assert.equal(fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8'), before)
  controller.destroy()
})

test('Enterprise edits use the existing draft and atomic writer; policy readers consume the saved values', async () => {
  reset()
  const before = fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8')
  let writes = 0
  const draft = createSettingsDraft()
  const controller = createResearchSettings({ shell: draftSettingsBridge({ read,
    set: (id, value) => { writes++; return settings.setProductSetting({ id, value }, options) },
    setMany: items => { writes++; return settings.setProductSettingsMany(items, options) },
  }, draft) })
  await controller.load()
  const edits = [
    ['agent.tool_approvals', true], ['purchases.require_owner_approval', true],
    ['audit.activity', 'Essential'],
    ['tools.audit_batch_window_ms', 4], ['tools.audit_batch_size', 32], ['fleet.max_declared_agents', 12],
  ]
  for (const [id, value] of edits) await controller.setValue(id, value)
  assert.equal(writes, 0)
  assert.equal(fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8'), before)
  assert.equal(draft.dirty, true)
  await draft.save()
  assert.equal(writes, 1)
  assert.equal(draft.dirty, false)
  const saved = JSON.parse(fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH))
  assert.equal(saved.revision, 12)
  for (const [id, value] of edits) assert.equal(saved.values[id], value)
  for (const id of ['agent.agent_api', 'agent.tool_mode', 'agent.subagent_route']) {
    assert.equal(saved.values[id], initial.values[id])
    assert.deepEqual(saved.provenance[id], initial.provenance[id])
  }
  const performance = engine('./src/lib/tool-performance-settings').performanceSettings({ fresh: true })
  assert.equal(performance['tools.audit_batch_window_ms'], 4)
  assert.equal(performance['tools.audit_batch_size'], 32)
  /* T782 reconciliation: audit.activity is a DORMANT preference. It was saved
     as Essential (checked in the edits loop above, with the batch/revision/
     provenance assertions preserved), but the Signed activity audit master
     (audit.enabled) is unchosen here, so the EFFECTIVE mode is Off -- engine
     runtime-policy.js resolves `activity: auditEnabled ? activity : 'Off'`
     while `retainedActivity` keeps the choice. The earlier expectation of
     'Essential' at this line read the dormant preference as if it were the
     effective mode; that expectation was wrong, not a regression, and is
     corrected here rather than erased. */
  assert.equal(engine('./src/lib/runtime-policy').runtimePolicy().activity, 'Off', 'an unchosen master yields the effective Off')
  assert.equal(engine('./src/lib/runtime-policy').runtimePolicy().retainedActivity, 'Essential', 'the saved Essential preference is kept, dormant, behind the master')
  assert.equal(engine('./src/lib/agent-org').resolveMaxAgents({ env: { ...process.env, MC_MAX_AGENTS: '' } }), 12)
  /* Explicit audit-on recovers the preference. A SEPARATE write, so the
     atomic-batch, revision-12, saved-bytes and provenance assertions above are
     untouched by it. */
  assert.equal(settings.setProductSetting({ id: 'audit.enabled', value: true }, options).ok, true)
  assert.equal(engine('./src/lib/runtime-policy').runtimePolicy().activity, 'Essential', 'explicit audit-on recovers the Essential preference the drawer kept')
  controller.destroy()
})

test('Strict keeps Fast-only batching controls unavailable in the Enterprise view', async () => {
  reset()
  assert.equal(settings.setProductSetting({ id: 'tools.throughput', value: 'strict' }, options).ok, true)
  let writes = 0
  const controller = createResearchSettings({ shell: { read, set: () => { writes++; return { ok: true } } } })
  await controller.load()
  const html = controller.markup({ section: ENTERPRISE_SECTION })
  for (const id of ['tools.audit_batch_window_ms', 'tools.audit_batch_size']) {
    assert.match(html, new RegExp(`data-research-number="${id}"[^>]*disabled`))
    await controller.setValue(id, 10)
  }
  assert.equal(writes, 0)
  controller.destroy()
})

test('an older or unavailable host exposes an explanation and no invented controls', async () => {
  const controller = createResearchSettings({ shell: { read: async () => ({ ok: true, available: true, rows: [] }) } })
  await controller.load()
  const html = controller.markup({ section: ENTERPRISE_SECTION })
  assert.match(html, /did not supply this control/)
  assert.doesNotMatch(html, /data-research-(?:number|setting|choice)="/)
  controller.destroy()
  assert.match(createResearchSettings({ shell: null }).markup({ section: ENTERPRISE_SECTION }), /Open the ToolsEnabled desktop app/)
})

test('Enterprise purchase OFF keeps the existing separate confirmation and cannot use a batch', () => {
  reset()
  const before = fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8')
  const single = settings.setProductSetting({ id: 'purchases.require_owner_approval', value: false }, options)
  assert.equal(single.code, 'SETTING_CONFIRMATION_REQUIRED')
  const batch = settings.setProductSettingsMany([{ id: 'purchases.require_owner_approval', value: false }], options)
  assert.equal(batch.code, 'SETTING_CONFIRMATION_REQUIRED')
  assert.equal(fs.readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8'), before)
})
