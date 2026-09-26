import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const dom = installDomStandIn()
const cells = new Map(), calls = []
globalThis.localStorage = { getItem: key => cells.get(key) ?? null, setItem: (key, value) => cells.set(key, String(value)), removeItem: key => cells.delete(key) }
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
document.getElementById = id => document.body.querySelector('#' + id)
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.mcShell = { getBridgeProof: async () => ({ ok: false }), getBridgeEndpoint: async () => ({ ok: false }) }
window.mcAgent = {
  nodeStatusRepairPreview: async value => { calls.push(['preview', value]); return { ok: true, previewToken: 'synthetic-review' } },
  nodeStatusRepairConfirm: async value => { calls.push(['confirm', value]); return { ok: false, reason: 'The person cancelled. Nothing was changed.' } },
}
const oldFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false }), text: async () => '' })
const { resolveDataSource } = await import('../../src/data-source.js')
await resolveDataSource()
const { settingsView } = await import('../../src/views/settings.js')
const { categorySlug } = await import('../../src/settings-presentation.js')
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

test('Settings Data and Privacy paints saved-data repair and a press reaches native review exactly once', async t => {
  const view = settingsView({ query: new URLSearchParams({ category: categorySlug('Data & Privacy') }), navigate() {} })
  t.after(() => view.destroy())
  document.body.appendChild(view.el)
  await settle()
  const button = view.el.querySelector('[data-saved-maintenance-action="repair"]')
  assert.ok(button, 'The person has no saved-status repair control on Settings')
  assert.equal(button.disabled, false)
  assert.deepEqual(calls, [], 'Opening Settings must not start maintenance')
  button.click(); await settle()
  assert.deepEqual(calls, [['preview', {}], ['confirm', { previewToken: 'synthetic-review' }]])
  assert.match(view.el.querySelector('[data-saved-maintenance-status]').textContent, /cancelled.*Nothing was changed/)
})

test('Settings offers saved-data maintenance through search without requiring Advanced mode', async t => {
  const view = settingsView({ query: new URLSearchParams({ q: 'orphan' }), navigate() {} })
  t.after(() => view.destroy())
  document.body.appendChild(view.el)
  await settle()
  const search = view.el.querySelector('.settings-search input')
  search.value = 'orphan'; search.dispatchEvent({ type: 'input' }); await settle()
  assert.ok(view.el.querySelector('[data-saved-maintenance-action="prune"]'), 'Search did not expose orphan cleanup')
})

test('an unsaved Settings change disables the Review buttons with the reason beside them', async t => {
  // T1568: the buttons went grey with no title and no sentence while the status
  // line still invited a review.
  const retention = { id: 'diagnostics.retention', present: true, applicable: true, enforcement: { declared: true }, control: 'seg',
    value: '30 days / 256 MiB', savedValue: '30 days / 256 MiB', options: ['Keep diagnostics', '30 days / 256 MiB'],
    label: 'Diagnostic retention', consequence: 'Controls closed diagnostic files.', capabilities: [], risks: [] }
  window.mcSettings = { stagesWrites: true, read: async () => ({ ok: true, available: true, rows: [retention] }), set: async (id, value) => ({ ok: true, value }) }
  const view = settingsView({ query: new URLSearchParams({ category: categorySlug('Data & Privacy') }), navigate() {} })
  t.after(() => { view.destroy(); delete window.mcSettings })
  document.body.appendChild(view.el)
  await settle(); await settle()
  // This fixture's bridge offers the repair review only.
  const repair = () => view.el.querySelector('[data-saved-maintenance-action="repair"]')
  const status = () => view.el.querySelector('[data-saved-maintenance-status]').textContent
  assert.equal(repair().disabled, false, 'the repair review starts enabled')
  assert.equal(repair().hasAttribute('title'), false)
  const keep = view.el.querySelectorAll('[data-research-choice="diagnostics.retention"]').find(button => button.getAttribute('data-research-value') === 'Keep diagnostics')
  assert.ok(keep, 'a real row on the page can be changed')
  keep.click(); await settle()
  assert.equal(view.el.dataset.settingsDirty, 'true', 'the page holds an unsaved change')
  assert.equal(repair().disabled, true)
  assert.match(repair().getAttribute('title') || '', /Save or discard your Settings changes first/, 'a disabled Review button carries no reason')
  assert.match(status(), /Save or discard your Settings changes first/, 'the status line still invites a review it will not run')
})

test.after(() => { globalThis.fetch = oldFetch; dom.restore() })
