import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const shell = require_(path.join(ROOT, 'shell', 'product-settings.cjs'))

function fixture({ loadRegistry, loadSettings } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'product-settings-'))
  const valuesPath = path.join(root, 'state', 'settings.json')
  const registryFile = path.join(root, shell.REGISTRY_FILE)
  mkdirSync(path.dirname(registryFile), { recursive: true })
  writeFileSync(registryFile, JSON.stringify({ titles: { 'research.pipeline': 'Pipeline title' } }))
  const entry = {
    control: 'boolean', depth: 0, default: false, consequence: 'Runs research',
    capabilities: ['research'], risks: ['network'],
  }
  const registry = { byId: new Map([['research.pipeline', entry]]) }
  const settings = {
    resolveValuesPath: () => valuesPath,
    loadSettings: loadSettings || (() => ({
      values: { 'research.pipeline': false },
      provenance: { 'research.pipeline': { source: 'default' } },
      enforcement: { 'research.pipeline': { declared: false, reason: 'No enforcer is declared' } },
      rejected: [], valuesPath, revision: 4,
    })),
  }
  const modules = { registry: { loadRegistry: loadRegistry || (() => registry) }, settings }
  const load = file => file.split(path.sep).join('/').endsWith('/agent-api-mode.js')
    ? { normalizeSettingChange: (id, value) => ({ id, value }), settingChangesWithCompatibility: (id, value) => [{ id, value }] }
    : file.split(path.sep).join('/').endsWith(shell.SETTINGS_MODULE) ? modules.settings : modules.registry
  return { root, valuesPath, registry, settings, options: { root, load, fresh: true } }
}

test('read failures remain unavailable and carry the reason instead of becoming a definite answer', () => {
  const absent = shell.readProductSettings({ root: '', fresh: true })
  assert.deepEqual(
    { available: absent.available, code: absent.code, rows: absent.rows },
    { available: false, code: 'SETTINGS_PAYLOAD_ABSENT', rows: [] },
  )
  assert.match(absent.reason, /payload/i)

  const broken = fixture({ loadRegistry: () => { throw new Error('catalogue denied') } })
  try {
    const answer = shell.readProductSettings(broken.options)
    assert.equal(answer.available, false, 'a registry read error is not reported as available')
    assert.equal(answer.code, 'SETTINGS_REGISTRY_UNREADABLE')
    assert.match(answer.reason, /catalogue denied/, 'the refusal retains the underlying reason')
  } finally { rmSync(broken.root, { recursive: true, force: true }) }
})

test('reading reports both present and unavailable rows and preserves an enforcement refusal', () => {
  const f = fixture()
  try {
    const answer = shell.readProductSettings(f.options)
    assert.equal(answer.available, true)
    const present = answer.rows.find(row => row.id === 'research.pipeline')
    const missing = answer.rows.find(row => row.id === 'research.runner_agent')
    assert.deepEqual(
      { present: present.present, value: present.value, declared: present.enforcement.declared },
      { present: true, value: false, declared: false },
    )
    assert.match(present.enforcement.reason, /enforcer/i)
    assert.equal(missing.present, false)
    assert.match(missing.reason, /not in .*registry/i)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

/* THE APPROVAL ROW (owner, 2026-09-02: an agent's filing may wait for the
   person). It is a writable row, listed directly after its sibling so the
   page draws the two sub-settings in order, and a write of it returns the
   payload's verdict exactly as every other row's does. */
test('the approval sub-setting is writable, listed after its sibling, and a write returns the payload verdict', () => {
  const ids = [...shell.WRITABLE_IDS]
  assert.ok(ids.includes('rules.agent_filed_needs_approval'), 'the approval row is not offered')
  assert.equal(ids.indexOf('rules.agent_filed_needs_approval'), ids.indexOf('rules.ask_when_unsure') + 1,
    'the approval row is drawn directly after the ask-when-unsure row')
  assert.equal(ids.indexOf('rules.ask_when_unsure'), ids.indexOf('rules.filing_from') + 1, 'and the pair stays under the three-way choice that superseded the switch')

  const f = fixture()
  mkdirSync(path.dirname(f.valuesPath), { recursive: true })
  writeFileSync(f.valuesPath, '{"revision":1,"values":{},"provenance":{}}\n')
  f.registry.byId.set('rules.agent_filed_needs_approval', {
    control: 'toggle', depth: 3, default: false, consequence: 'An agent-filed rule waits for you.',
    capabilities: ['approval'], risks: ['delay'],
  })
  f.settings.loadSettings = () => {
    const document = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
    const value = document.values['rules.agent_filed_needs_approval']
    return {
      values: { 'rules.agent_filed_needs_approval': value },
      provenance: { 'rules.agent_filed_needs_approval': document.provenance['rules.agent_filed_needs_approval'] },
      enforcement: { 'rules.agent_filed_needs_approval': { declared: true } },
      rejected: [], valuesPath: f.valuesPath, revision: document.revision,
    }
  }
  try {
    const accepted = shell.setProductSetting({ id: 'rules.agent_filed_needs_approval', value: true }, f.options)
    assert.deepEqual(
      { ok: accepted.ok, id: accepted.id, value: accepted.value, source: accepted.provenance.source },
      { ok: true, id: 'rules.agent_filed_needs_approval', value: true, source: 'user' },
      'the write must carry the user stamp: only a user/installer true turns approval on',
    )
    assert.equal(accepted.enforcement.declared, true)
    const stored = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
    assert.equal(stored.values['rules.agent_filed_needs_approval'], true)
    assert.equal(stored.provenance['rules.agent_filed_needs_approval'].source, 'user')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the writer rejects an unlisted id with a named refusal before touching settings', () => {
  const answer = shell.setProductSetting({ id: 'payments.override', value: true }, {
    root: '/must-not-be-loaded',
    load: () => { throw new Error('the allowlist refusal loaded the payload') },
    fresh: true,
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'SETTING_NOT_WRITABLE')
  assert.match(answer.reason, /payments\.override/)
})

test('the complete per-turn rules choice persists both on and off with user provenance', () => {
  const id = 'rules.require_read_each_turn'
  assert.ok(shell.WRITABLE_IDS.includes(id))
  const f = fixture()
  mkdirSync(path.dirname(f.valuesPath), { recursive: true })
  writeFileSync(f.valuesPath, '{"revision":1,"values":{},"provenance":{}}\n')
  f.registry.byId.set(id, { control: 'toggle', depth: 1, default: false, consequence: 'Include every applicable rule.', capabilities: [], risks: [] })
  f.settings.loadSettings = () => {
    const document = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
    return { values: document.values, provenance: document.provenance,
      enforcement: { [id]: { declared: true } }, rejected: [], valuesPath: f.valuesPath, revision: document.revision }
  }
  try {
    for (const value of [true, false]) {
      const saved = shell.setProductSetting({ id, value }, f.options)
      assert.equal(saved.ok, true)
      assert.equal(saved.value, value)
      assert.equal(saved.provenance.source, 'user')
      const stored = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
      assert.equal(stored.values[id], value)
      assert.equal(stored.provenance[id].source, 'user')
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an accepted write returns the payload verdict, while a refused value restores the prior document', () => {
  const f = fixture()
  mkdirSync(path.dirname(f.valuesPath), { recursive: true })
  const original = '{"revision":7,"values":{"other":true},"provenance":{}}\n'
  writeFileSync(f.valuesPath, original)
  f.settings.loadSettings = () => {
    const document = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
    const value = document.values['research.pipeline']
    return {
      values: { 'research.pipeline': value },
      provenance: { 'research.pipeline': document.provenance['research.pipeline'] },
      enforcement: { 'research.pipeline': { declared: true } },
      rejected: value === 'invalid' ? [{ id: 'research.pipeline', reason: 'A boolean is required' }] : [],
      valuesPath: f.valuesPath, revision: document.revision,
    }
  }
  try {
    const accepted = shell.setProductSetting({ id: 'research.pipeline', value: true }, f.options)
    assert.deepEqual(
      { ok: accepted.ok, value: accepted.value, source: accepted.provenance.source, revision: accepted.revision },
      { ok: true, value: true, source: 'user', revision: 8 },
    )
    assert.equal(accepted.enforcement.declared, true)

    writeFileSync(f.valuesPath, original)
    const refused = shell.setProductSetting({ id: 'research.pipeline', value: 'invalid' }, f.options)
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'SETTING_VALUE_REFUSED')
    assert.match(refused.reason, /boolean/i)
    assert.equal(refused.restoreStatus, 'restored')
    assert.match(refused.reason, /restored/i)
    assert.equal(readFileSync(f.valuesPath, 'utf8'), original, 'validation refusal restores the exact prior document')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('post-write confirmation distinguishes failed restoration from an unconfirmed restoration', () => {
  const scenarios = [
    {
      label: 'restore-failed',
      install(f) {
        const originalWrite = fs.writeFileSync
        let restoring = false
        fs.writeFileSync = function (...args) {
          if (restoring && args[0] === f.valuesPath) {
            throw Object.assign(new Error('restore denied'), { code: 'EACCES' })
          }
          return originalWrite.apply(this, args)
        }
        f.settings.loadSettings = () => {
          restoring = true
          throw Object.assign(new Error('confirmation unavailable'), { code: 'EIO' })
        }
        return () => { fs.writeFileSync = originalWrite }
      },
      expected: 'restore-failed',
    },
    {
      label: 'unknown',
      install(f) {
        const originalRead = fs.readFileSync
        let confirmingRestore = false
        fs.readFileSync = function (...args) {
          if (confirmingRestore && args[0] === f.valuesPath) {
            throw Object.assign(new Error('restore verification denied'), { code: 'EIO' })
          }
          return originalRead.apply(this, args)
        }
        f.settings.loadSettings = () => {
          confirmingRestore = true
          throw Object.assign(new Error('confirmation unavailable'), { code: 'EIO' })
        }
        return () => { fs.readFileSync = originalRead }
      },
      expected: 'unknown',
    },
  ]

  for (const scenario of scenarios) {
    const f = fixture()
    mkdirSync(path.dirname(f.valuesPath), { recursive: true })
    writeFileSync(f.valuesPath, '{"revision":7,"values":{"other":true},"provenance":{}}\n')
    const restoreHooks = scenario.install(f)
    try {
      const answer = shell.setProductSetting({ id: 'research.pipeline', value: true }, f.options)
      assert.equal(answer.ok, false, scenario.label)
      assert.equal(answer.code, 'SETTINGS_UNREADABLE', scenario.label)
      assert.equal(answer.restoreStatus, scenario.expected, scenario.label)
      assert.match(answer.reason, /confirmation unavailable/, scenario.label)
      assert.match(answer.reason, /settings may have changed/i, scenario.label)
      assert.match(answer.reason, scenario.expected === 'restore-failed' ? /could not be written back/ : /did not confirm/, scenario.label)
      assert.doesNotMatch(answer.reason, /(?:were|was) restored|put back|restore-failed|unknown/i, scenario.label)
    } finally {
      restoreHooks()
      rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('batch post-write verification propagates restoration status after final actual-path failure', () => {
  const f = fixture()
  mkdirSync(path.dirname(f.valuesPath), { recursive: true })
  const original = '{"revision":7,"values":{"other":true},"provenance":{}}\n'
  writeFileSync(f.valuesPath, original)
  let settingsReads = 0
  f.settings.loadSettings = ({ valuesPath = f.valuesPath } = {}) => {
    settingsReads += 1
    if (valuesPath === f.valuesPath && settingsReads === 3) {
      throw Object.assign(new Error('final confirmation unavailable'), { code: 'EIO' })
    }
    const document = JSON.parse(readFileSync(valuesPath, 'utf8'))
    return {
      values: document.values,
      provenance: document.provenance,
      enforcement: { 'research.pipeline': { declared: true } },
      rejected: [],
      valuesPath,
      revision: document.revision,
    }
  }
  try {
    const answer = shell.setProductSettingsMany([{ id: 'research.pipeline', value: true }], f.options)
    assert.equal(settingsReads, 3, 'the fixture permits initial and candidate reads, then fails final actual-path confirmation')
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'SETTINGS_UNREADABLE')
    assert.equal(answer.restoreStatus, 'restored')
    assert.deepEqual(answer.results, [])
    assert.match(answer.reason, /final confirmation unavailable/)
    assert.match(answer.reason, /settings were restored/i)
    assert.equal(readFileSync(f.valuesPath, 'utf8'), original, 'the batch restores the exact prior document')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a mismatching restore write is reported as unknown rather than retained bytes', () => {
  const f = fixture()
  mkdirSync(path.dirname(f.valuesPath), { recursive: true })
  const original = '{"revision":7,"values":{"other":true},"provenance":{}}\n'
  writeFileSync(f.valuesPath, original)
  const originalWrite = fs.writeFileSync
  let restoring = false
  fs.writeFileSync = function (...args) {
    if (restoring && args[0] === f.valuesPath) {
      return originalWrite.call(this, args[0], `${args[1]}tampered`, args[2])
    }
    return originalWrite.apply(this, args)
  }
  f.settings.loadSettings = () => {
    restoring = true
    throw Object.assign(new Error('confirmation unavailable'), { code: 'EIO' })
  }
  try {
    const answer = shell.setProductSetting({ id: 'research.pipeline', value: true }, f.options)
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'SETTINGS_UNREADABLE')
    assert.equal(answer.restoreStatus, 'unknown')
    assert.match(answer.reason, /confirmation unavailable/)
    assert.match(answer.reason, /settings may have changed/i)
    assert.match(answer.reason, /did not confirm/)
    assert.doesNotMatch(answer.reason, /(?:were|was) restored|put back|unknown/i)
    assert.notEqual(readFileSync(f.valuesPath, 'utf8'), original, 'a mismatching restore must not claim the old bytes survived')
  } finally {
    fs.writeFileSync = originalWrite
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('an absent prior document is confirmed restored after a failed post-write read', () => {
  const f = fixture()
  f.settings.loadSettings = () => {
    throw Object.assign(new Error('confirmation unavailable'), { code: 'EIO' })
  }
  try {
    assert.equal(fs.existsSync(f.valuesPath), false, 'the absent-before fixture starts without a settings document')
    const answer = shell.setProductSetting({ id: 'research.pipeline', value: true }, f.options)
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'SETTINGS_UNREADABLE')
    assert.equal(answer.restoreStatus, 'restored')
    assert.match(answer.reason, /confirmation unavailable/)
    assert.match(answer.reason, /settings were restored/i)
    assert.equal(fs.existsSync(f.valuesPath), false, 'absence is confirmed after restoration')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

/* THE FOLDED ROWS KEEP THEIR OWN CONTROLS.
 *
 * The "How much it checks with you" quick slider
 * (src/settings-quick-sliders.js) sets agent.tool_approvals together with
 * agent.blocked_question, because five positions over one three-value row
 * would have to invent stops that enforce nothing. Folding a row into a
 * ladder must not be how a person loses the ability to set it on its own:
 * both rows keep a standalone control in their category on the full Settings
 * page, and each still writes by itself through the row's own writer. This
 * pins that -- if a later change removes the individual control or stops it
 * round-tripping, the fold has quietly become a split and this fails. */
test('a row a quick slider folds is still settable on its own, and round-trips both ways', async () => {
  const { PRODUCT_SETTING_PRESENTATION } = await import('../../src/product-settings-layout.js')
  const { QUICK_SLIDERS } = await import('../../src/settings-quick-sliders.js')
  const folded = QUICK_SLIDERS
    .filter(spec => spec.stops.some(stop => Object.keys(stop.values).length > 1))
    .flatMap(spec => [...new Set(spec.stops.flatMap(stop => Object.keys(stop.values)))])
  assert.ok(folded.includes('agent.tool_approvals'), 'the approvals row is one of the folded rows')

  for (const id of new Set(folded)) {
    const presentation = PRODUCT_SETTING_PRESENTATION[id]
    assert.ok(presentation, `${id} still has its own control on the full Settings page`)
    assert.ok(presentation.title && presentation.group, `${id}'s standalone control still names itself and its group`)
    assert.ok(shell.WRITABLE_IDS.includes(id), `${id} is still writable on its own`)
  }

  const id = 'agent.tool_approvals'
  const f = fixture()
  mkdirSync(path.dirname(f.valuesPath), { recursive: true })
  writeFileSync(f.valuesPath, '{"revision":1,"values":{},"provenance":{}}\n')
  f.registry.byId.set(id, { control: 'toggle', depth: 1, default: true, consequence: 'Ask before a consequential tool call.', capabilities: [], risks: [] })
  f.settings.loadSettings = () => {
    const document = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
    return { values: document.values, provenance: document.provenance,
      enforcement: { [id]: { declared: true } }, rejected: [], valuesPath: f.valuesPath, revision: document.revision }
  }
  try {
    // On its own, without the other row of the ladder being written at all.
    for (const value of [false, true]) {
      const saved = shell.setProductSetting({ id, value }, f.options)
      assert.equal(saved.ok, true, `${id} writes on its own`)
      assert.equal(saved.value, value)
      const stored = JSON.parse(readFileSync(f.valuesPath, 'utf8'))
      assert.equal(stored.values[id], value, `${id} reads back as written`)
      assert.equal(stored.provenance[id].source, 'user', 'a hand edit stays the person\u2019s own')
      assert.ok(!('agent.blocked_question' in stored.values),
        'setting the approvals row alone does not drag the rest of the ladder with it')
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

function apiSupportFixture(loadPolicy) {
  const f = fixture()
  const values = { 'agent.agent_api': 'Only', 'agent.tool_summary': false, 'agent.capability_recall': true }
  for (const [id, value] of Object.entries(values)) {
    f.registry.byId.set(id, { control: id === 'agent.agent_api' ? 'seg' : 'toggle',
      options: id === 'agent.agent_api' ? ['Only', 'Enabled', 'Disabled'] : [],
      default: value, capabilities: [], risks: [] })
  }
  f.settings.loadSettings = () => ({ values: { ...values },
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])),
    enforcement: {}, rejected: [], valuesPath: f.valuesPath, revision: 7 })
  const originalLoad = f.options.load
  f.options.load = file => file === path.join(f.root, 'src', 'lib', 'agent-api-policy.js')
    ? loadPolicy() : originalLoad(file)
  return f
}

test('Agent API support metadata comes from the paired policy without changing saved values or provenance', () => {
  let calls = 0
  const matrix = Object.freeze({ scope: 'installation', appliesTo: 'new-sessions', providers: [
    { provider: 'supported-provider', status: 'supported', reason: 'Selection can be enforced.', nativeTools: ['SelectedTool'] },
    { provider: 'refused-provider', status: 'unsupported', reason: 'Selection cannot be enforced.', nativeTools: [] },
    { provider: 'unknown-provider', status: 'unknown', reason: 'Support has not been established.', nativeTools: [] },
  ] })
  const f = apiSupportFixture(() => ({ optimizedApiSupport() { calls++; return matrix } }))
  const answer = shell.readProductSettings(f.options)
  assert.equal(answer.ok, true)
  assert.equal(answer.available, true)
  const api = answer.rows.find(row => row.id === 'agent.agent_api')
  assert.deepEqual(api.optimizedSupport, matrix)
  assert.equal(calls, 1)
  assert.equal(api.value, 'Only')
  assert.deepEqual(api.provenance, { source: 'user' })
  assert.deepEqual(api.options, ['Only', 'Enabled', 'Disabled'])
  for (const [id, value] of [['agent.tool_summary', false], ['agent.capability_recall', true]]) {
    assert.equal(answer.rows.find(row => row.id === id).value, value)
  }
})

test('missing or unreadable Optimized support metadata leaves settings and discovery readable with unknown support', () => {
  for (const loadPolicy of [
    () => ({}),
    () => { throw new Error('Policy read unavailable') },
    () => ({ optimizedApiSupport() { throw new Error('Support probe unavailable') } }),
    () => ({ optimizedApiSupport() { return { scope: 'session', providers: [] } } }),
  ]) {
    const f = apiSupportFixture(loadPolicy)
    const answer = shell.readProductSettings(f.options)
    assert.equal(answer.ok, true)
    assert.equal(answer.available, true)
    const api = answer.rows.find(row => row.id === 'agent.agent_api')
    assert.equal(api.value, 'Only')
    assert.deepEqual(api.options, ['Only', 'Enabled', 'Disabled'])
    assert.deepEqual(api.optimizedSupport.providers, [])
    assert.equal(api.optimizedSupport.scope, 'installation')
    assert.equal(api.optimizedSupport.appliesTo, 'new-sessions')
    assert.match(api.optimizedSupport.reason, /could not be read/i)
    assert.equal(answer.rows.find(row => row.id === 'agent.tool_summary').value, false)
    assert.equal(answer.rows.find(row => row.id === 'agent.capability_recall').value, true)
  }
})
