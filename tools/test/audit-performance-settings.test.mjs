import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { auditPerformanceSettingsMarkup, bindAuditPerformanceSettings } from '../../src/audit-performance-settings.js'

const require = createRequire(import.meta.url)
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engine = process.env.MC_TEST_AUDIT_PAYLOAD || process.env.MC_CANONICAL_ROOT || path.resolve(app, 'capability')
const shell = require('../../shell/product-settings.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(bridge) {
  const rows = new Map(['audit.activity', 'tools.throughput'].map(id => {
    const choices = id === 'audit.activity' ? ['Full', 'Essential', 'Off'] : ['fast', 'strict']
    const buttons = choices.map(value => ({ dataset: { auditChoice: value }, disabled: true, pressed: 'false',
      setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value }, classList: { toggle() {} } }))
    const status = { textContent: '' }
    let click
    const root = { querySelectorAll: () => buttons, querySelector: () => status,
      contains: button => buttons.includes(button), addEventListener: (_, handler) => { click = handler } }
    return [id, { root, buttons, status, press: value => click({ target: { closest: () => buttons.find(item => item.dataset.auditChoice === value) } }) }]
  }))
  bindAuditPerformanceSettings({ querySelector: selector => rows.get(selector.match(/="([^"]+)"/)[1])?.root }, bridge)
  return rows
}

test('the actual settings writer changes the engine reader through both visible controls', async () => {
  assert.ok(fs.existsSync(path.join(engine, 'src/lib/runtime-policy.js')), 'Use MC_TEST_AUDIT_PAYLOAD to select the tested capability payload')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-setting-drive-'))
  const prior = { ...process.env }
  process.env.TOOLSENABLED_SETTINGS_PATH = path.join(root, 'settings.json')
  process.env.TOOLSENABLED_STATE_ROOT = root
  process.env.LOCALAPPDATA = root
  // The reader the shipped Engine uses. audit-activity.js has had no production
  // caller since audit became optional, so a packed capability layer omits it.
  const runtimePolicy = require(path.join(engine, 'src/lib/runtime-policy.js'))
  const activity = { activityMode: options => runtimePolicy.runtimePolicy(options).activity }
  const throughput = require(path.join(engine, 'src/lib/throughput-mode.js'))
  let refuse = false
  const rows = fixture({ read: async () => shell.readProductSettings({ root: engine }),
    set: async (id, value) => refuse ? { ok: false } : shell.setProductSetting({ id, value }, { root: engine }) })
  try {
    await tick()
    const auditRow = rows.get('audit.activity'), speedRow = rows.get('tools.throughput')
    // The Basic default for audit.activity is Off (owner direction 2026-09-20,
    // T782): a fresh copy paints Off selected, not Full.
    assert.equal(auditRow.buttons.find(item => item.pressed === 'true')?.dataset.auditChoice, 'Off')
    /* THE MASTER GATE (root 2026-09-21). The engine's runtime-policy makes a
       saved audit.activity a DORMANT preference until Signed activity audit is
       on: activity = auditEnabled ? activity : 'Off', and retainedActivity
       keeps the choice. Turn the master on so the writer->reader roundtrip
       below reads the EFFECTIVE mode; the dormant/effective/master-on
       distinction is asserted at the end. The initial pressed state above is
       read before this and is unaffected (it is audit.activity, not the
       master). */
    assert.equal(shell.setProductSetting({ id: 'audit.enabled', value: true }, { root: engine }).ok, true)
    for (const value of ['Essential', 'Off', 'Full']) {
      await auditRow.press(value)
      // {fresh:true} for the same reason the throughput reader below uses it:
      // rapid writes share an mtime-second, and the master gate now makes the
      // effective mode depend on the audit.enabled write above as well.
      assert.equal(activity.activityMode({ fresh: true }), value)
      assert.equal(auditRow.buttons.find(item => item.pressed === 'true')?.dataset.auditChoice, value)
    }
    for (const value of ['strict', 'fast']) {
      await speedRow.press(value)
      assert.equal(throughput.throughputMode({ fresh: true }), value)
    }
    refuse = true
    await auditRow.press('Off')
    assert.equal(activity.activityMode({ fresh: true }), 'Full')
    assert.equal(auditRow.buttons.find(item => item.pressed === 'true')?.dataset.auditChoice, 'Full')
    assert.match(auditRow.status.textContent, /Could not save/)

    /* THE SAME DISTINCTION THE ENTERPRISE READER GOT (root 2026-09-21). The
       roundtrip above is preserved; it just ran under an explicit master-on.
       With the master off the last saved choice ('Full') is DORMANT: the
       effective mode is Off, and retainedActivity keeps the value. Explicit
       master-on recovers it. No writer/roundtrip assertion above is changed. */
    refuse = false
    assert.equal(shell.setProductSetting({ id: 'audit.enabled', value: false }, { root: engine }).ok, true)
    // {fresh:true} bypasses the settings read-cache the throughput reader above
    // also opts out of; two audit.enabled writes in the same second otherwise
    // share an mtime and the reader returns the stale policy.
    assert.equal(activity.activityMode({ fresh: true }), 'Off', 'master off yields the effective Off')
    assert.equal(require(path.join(engine, 'src/lib/runtime-policy')).runtimePolicy({ fresh: true }).retainedActivity, 'Full',
      'the saved Full preference is kept, dormant, behind the master')
    assert.equal(shell.setProductSetting({ id: 'audit.enabled', value: true }, { root: engine }).ok, true)
    assert.equal(activity.activityMode({ fresh: true }), 'Full', 'explicit master-on recovers the saved Full preference')
  } finally {
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(prior, name)) delete process.env[name]
    Object.assign(process.env, prior)
    shell.resetForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unavailable settings remain unselected and cannot write', async () => {
  let writes = 0
  const rows = fixture({ read: async () => ({ ok: false }), set: async () => { writes++ } })
  await tick()
  for (const row of rows.values()) {
    assert.ok(row.buttons.every(item => item.disabled && item.pressed === 'false'))
    await row.press(row.buttons[0].dataset.auditChoice)
  }
  assert.equal(writes, 0)
})

test('choices disclose lost records, required security records, and the absence of a speed guarantee', () => {
  const html = auditPerformanceSettingsMarkup()
  assert.match(html, /aria-label="Tool activity audit"/)
  assert.match(html, /Off does not mean zero records/)
  assert.match(html, /Permissions, sandboxing and vault protection stay active/)
  assert.match(html, /Speed depends on the tool, storage and queue load/)
  assert.equal((html.match(/aria-pressed="false" disabled/g) || []).length, 5)
})

/* T782 reconciliation: audit.activity is a dormant preference gated on the
   Signed activity audit master (engine runtime-policy.js:
   activity = auditEnabled ? activity : 'Off'; retainedActivity keeps the
   choice). The quick drawer must not say required records stay on in every
   mode, or that Full records, unconditionally. New operations do not request
   audit records while the master is off; admitted work can finish recording. This pins the qualification without changing any policy. */
test('the quick drawer qualifies required-record and Full copy under the Signed activity audit master', async () => {
  const html = auditPerformanceSettingsMarkup()
  assert.match(html, /it applies while Signed activity audit is on\. With Signed activity audit off, the choice is kept for later and new operations do not request audit records\. Work already underway may finish recording/)
  assert.doesNotMatch(html, /the choice is kept and (?:nothing is written|no new records are written)/, 'master-off stops new operations requesting records; admitted audited calls may still finish recording')
  assert.match(html, /While Signed activity audit is on, required security, approval and protected-action records stay on in every mode, so Off does not mean zero records/)
  assert.doesNotMatch(html, /Required security, approval and protected-action records stay on in every mode\. Off does not mean zero records/,
    'the old unconditional claim is gone: it was false with the master off')
  assert.match(html, /Permissions, sandboxing and vault protection stay active regardless/,
    'the non-audit protections remain unconditional, because they are')

  /* The Full choice's own description is shown in the status when Full is the
     saved choice (bindAuditPerformanceSettings paint -> descriptions[selected]);
     it is likewise qualified, so "Full records" is not claimed while the
     master is off. */
  const rows = fixture({ read: async () => ({ ok: true, available: true, rows: [
    { id: 'audit.activity', present: true, control: 'seg', options: ['Full', 'Essential', 'Off'], value: 'Full' },
    { id: 'tools.throughput', present: true, control: 'seg', options: ['fast', 'strict'], value: 'fast' },
  ] }), set: async () => ({ ok: true }) })
  await tick(); await tick()
  assert.match(rows.get('audit.activity').status.textContent,
    /While Signed activity audit is on, record signed success and failure summaries for completed API calls/,
    'the Full description shown to the person is qualified under the master')
})
