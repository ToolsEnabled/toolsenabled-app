/* THE APP/ENGINE SETTINGS-ROW GATE (tools/check-settings-rows-declared.mjs).
 *
 * Measured 2026-09-16 on cut 1 of 1.0.45: the app read `rules.filing_from` in
 * its presets and its rules slider while the packed engine registry did not
 * declare it, and every gate stayed green. This suite pins that the gate reads
 * the rows from the constants that own them, reads the packed registry, names
 * every missing row, and refuses to call an unmeasured tree a pass. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { referencedRows, declaredRows, verdict } from '../check-settings-rows-declared.mjs'

/* A tree with the four source constants and a packed registry, small enough to
   read at a glance; the ids are shaped like the product's own. */
function tree({ registryIds = ['rules.filing_from', 'agent.tool_approvals', 'fleet.max_declared_agents', 'audit.retention', 'agent.tool_summary'], withRegistry = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rows-declared-'))
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, 'capability', 'config'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'research-settings.js'), [
    '// "app.some_prose" appears in a sentence and must not count',
    'export const PRODUCT_SETTING_IDS = Object.freeze([',
    '  "rules.filing_from",',
    '  "agent.tool_approvals",',
    '])',
    'export const OTHER = ["fleet.not_a_row_here"]',
  ].join('\n'))
  writeFileSync(path.join(root, 'src', 'settings-profile-policy.js'), [
    'export const PROFILE_PRODUCT_VALUES = Object.freeze({',
    "  'agent.tool_approvals': [true, false],",
    "  'fleet.max_declared_agents': [8, 512],",
    '})',
    'export const PROFILE_PRODUCT_PRESERVED = Object.freeze({',
    "  'agent.tool_summary': 'Keep it.',",
    '})',
  ].join('\n'))
  writeFileSync(path.join(root, 'src', 'settings-quick-sliders.js'), [
    'export const QUICK_SLIDERS = Object.freeze([',
    "  { key: 'audit.retention', stops: [{ label: 'x', values: { 'audit.retention': 'Keep everything' } }] },",
    '])',
  ].join('\n'))
  if (withRegistry) {
    writeFileSync(path.join(root, 'capability', 'config', 'settings-registry.json'),
      JSON.stringify({ schemaVersion: 1, settings: registryIds.map(id => ({ id, control: 'toggle' })) }))
  }
  return root
}

test('the rows come from the owning constants only, in both quote styles, and never from prose', () => {
  const rows = referencedRows(tree())
  assert.deepEqual([...rows.keys()].sort(), ['agent.tool_approvals', 'agent.tool_summary', 'audit.retention', 'fleet.max_declared_agents', 'rules.filing_from'])
  assert.equal(rows.has('app.some_prose'), false)
  assert.equal(rows.has('fleet.not_a_row_here'), false, 'a constant the gate does not own is not read')
})

test('the packed registry ids are read from the registry file', () => {
  const root = tree()
  assert.deepEqual([...declaredRows(path.join(root, 'capability', 'config', 'settings-registry.json'))].sort(),
    ['agent.tool_approvals', 'agent.tool_summary', 'audit.retention', 'fleet.max_declared_agents', 'rules.filing_from'])
})

test('a pair that agrees passes with nothing missing', () => {
  const root = tree()
  const result = verdict({ root, registryFile: path.join(root, 'capability', 'config', 'settings-registry.json') })
  assert.deepEqual(result.missing, [])
  assert.equal(result.referenced, 5)
})

test('a row the app draws that the engine never declared is named, with the constant that draws it', () => {
  const root = tree({ registryIds: ['agent.tool_approvals', 'fleet.max_declared_agents', 'audit.retention', 'agent.tool_summary'] })
  const result = verdict({ root, registryFile: path.join(root, 'capability', 'config', 'settings-registry.json') })
  assert.deepEqual(result.missing.map(row => row.id), ['rules.filing_from'])
  assert.match(result.missing[0].why, /full Settings page/)
})

test('no packed registry is not a pass', () => {
  const root = tree({ withRegistry: false })
  assert.throws(() => verdict({ root, registryFile: path.join(root, 'capability', 'config', 'settings-registry.json') }), /no packed registry/)
})

test('a constant that names no rows is not a pass either', () => {
  const root = tree()
  writeFileSync(path.join(root, 'src', 'settings-quick-sliders.js'), 'export const QUICK_SLIDERS = Object.freeze([\n])\n')
  assert.throws(() => referencedRows(root), /named no settings rows/)
})
