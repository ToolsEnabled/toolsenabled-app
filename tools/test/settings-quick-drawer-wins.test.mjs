/*
 * T1483: a choice made in the Quick settings drawer while the same Settings
 * row had an unsaved change was silently undone by the next Save settings:
 * the page kept its older pending value staged and wrote it back.
 *
 * This mounts the shipped settingsView on Appearance, stages Theme 'Black' on
 * the page, then does what the drawer does (store 'Ember' and announce the
 * quick-setting event), and saves another change.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const dom = installDomStandIn()
const cells = new Map([['mc.settings.mode', 'advanced'], ['mc.theme', 'white']])
globalThis.localStorage = {
  getItem: key => cells.get(key) ?? null,
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: key => cells.delete(key),
}
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
document.getElementById = id => document.body.querySelector('#' + id)
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.location = window.location = { hash: '#/settings', reload() {} }
globalThis.confirm = () => true
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false }), text: async () => '' })
window.mcShell = { getBridgeProof: async () => ({ ok: false }), getBridgeEndpoint: async () => ({ ok: false }), getBridgeTransport: async () => ({ ok: false }) }

const { resolveDataSource } = await import('../../src/data-source.js')
await resolveDataSource()
const { settingsView } = await import('../../src/views/settings.js')
const { categorySlug } = await import('../../src/settings-presentation.js')
const { QUICK_SETTING_EVENT } = await import('../../src/quick-settings.js')

const settle = async (turns = 16) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }
const choice = (view, id, value) => view.el.querySelector(`[data-setting-id="${id}"]`)
  ?.querySelectorAll('[data-setting-value]').find(button => button.dataset.settingValue === value)
// The stand-in cannot match the page's 'button[data-setting-value]' selector, so
// the press carries a target that answers it, as settings-category-router does.
const press = button => button.dispatchEvent({ type: 'click',
  target: { closest: selector => selector === 'button[data-setting-value]' ? button : button.closest(selector) } })

test('a Quick settings choice made while the same row is pending survives the next Save', async t => {
  const view = settingsView({ query: new URLSearchParams({ category: categorySlug('Appearance') }), navigate() {} })
  document.body.appendChild(view.el)
  t.after(() => { view.destroy(); view.el.remove(); dom.restore() })
  await settle()

  const black = choice(view, 'theme', 'black')
  assert.ok(black, 'the real Theme row is mounted')
  press(black); await settle()
  assert.equal(view.el.dataset.settingsDirty, 'true', 'the page holds Theme Black as an unsaved change')

  // What the drawer does: apply and store at once, then announce it.
  cells.set('mc.theme', 'ember')
  window.dispatchEvent({ type: QUICK_SETTING_EVENT, detail: { settingId: 'theme', value: 'ember' } })
  await settle()
  assert.equal(view.el.dataset.settingsDirty, 'false', 'the older page choice for the same row is still pending')

  // Another change on the page, then Save: the drawer's Ember must stay.
  const circles = choice(view, 'tree_style', 'circles')
  assert.ok(circles, 'another real row can be changed')
  press(circles); await settle()
  assert.equal(view.el.dataset.settingsDirty, 'true')
  view.el.querySelector('[data-settings-save]').click(); await settle()
  assert.equal(cells.get('mc.theme'), 'ember', 'Save wrote the older page choice back over the drawer choice')
})
