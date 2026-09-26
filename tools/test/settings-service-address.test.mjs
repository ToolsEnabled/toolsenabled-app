/*
 * T1403: a Local models Service address without http:// (e.g. the way Ollama
 * prints it, localhost:11434) was staged as a normal change; the only hint sat
 * under a different row and the whole Save failed later, taking the AI service
 * choice staged with it.
 *
 * This mounts the shipped settingsView on Local models with a bridge-shaped
 * mcSettings and types into the real Service address field. The stand-in DOM
 * supplies bounded HTML, selectors and events only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const dom = installDomStandIn()
const cells = new Map([['mc.settings.mode', 'advanced']])
const sets = []
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
const elementPrototype = Object.getPrototypeOf(document.createElement('div'))
if (!Object.getOwnPropertyDescriptor(elementPrototype, 'outerHTML')) {
  Object.defineProperty(elementPrototype, 'outerHTML', {
    configurable: true,
    get() { return this.innerHTML },
    set(value) {
      if (!this.parentNode) return
      const holder = document.createElement('div')
      holder.innerHTML = String(value)
      const replacement = holder.firstElementChild
      if (replacement) this.replaceWith(replacement)
      else this.remove()
    },
  })
}
window.mcProviders = {
  presence: async () => ({ ok: true, providers: [] }),
  accounts: async () => ({ ok: true, accounts: [], active: null }),
  detectLocal: async () => ({ ok: true, runtimes: [] }),
  onLoginEvent: () => () => {},
}
window.mcShell = { getBridgeProof: async () => ({ ok: false }), getBridgeEndpoint: async () => ({ ok: false }), getBridgeTransport: async () => ({ ok: false }) }

const row = (id, control, value, extra = {}) => ({
  id, present: true, applicable: true, enforcement: { declared: true }, control, value, savedValue: value,
  label: id, consequence: id, capabilities: [], risks: [], ...extra,
})
window.mcSettings = {
  stagesWrites: true,
  read: async () => ({ ok: true, available: true, rows: [
    row('model.provider', 'seg', 'Ollama', { options: ['Ollama', 'OpenAI-compatible'] }),
    row('model.endpoint', 'text', ''),
  ] }),
  set: async (id, value) => { sets.push({ id, value }); return { ok: true, value } },
}

const { resolveDataSource } = await import('../../src/data-source.js')
await resolveDataSource()
const { settingsView } = await import('../../src/views/settings.js')
const { categorySlug } = await import('../../src/settings-presentation.js')

const settle = async (turns = 16) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }

function type(field, value) {
  field.value = value
  field.dispatchEvent({ type: 'input' })
  field.dispatchEvent({ type: 'change' })
}

test('a Service address without http:// holds Save with the reason on its own row', async t => {
  const view = settingsView({ query: new URLSearchParams({ category: categorySlug('Local models') }), navigate() {} })
  document.body.appendChild(view.el)
  t.after(() => { view.destroy(); view.el.remove(); dom.restore() })
  await settle()

  const field = () => view.el.querySelector('[data-research-text="model.endpoint"]')
  const save = () => view.el.querySelector('[data-settings-save]')
  const status = () => view.el.querySelector('[data-settings-draft-status]').textContent
  const addressRow = () => field()?.closest('[data-setting-id]')
  assert.ok(field(), 'the real Service address field is mounted')

  type(field(), 'localhost:11434')
  await settle()
  assert.equal(save().disabled, true, 'Save stays available for an address that cannot be saved')
  assert.equal(view.el.dataset.settingsSaveState, 'invalid')
  assert.match(status(), /Correct the highlighted value before saving\. Enter a full AI service address beginning with http:\/\/ or https:\/\//)
  assert.match(addressRow().textContent, /http:\/\/ or https:\/\//, 'the Service address row does not say what is wrong')

  type(field(), 'http://user:secret@127.0.0.1:11434')
  await settle()
  assert.equal(save().disabled, true, 'an address with a login is held too')
  assert.match(status(), /without a user name, password, query or fragment/)

  type(field(), 'http://127.0.0.1:11434')
  await settle()
  assert.equal(save().disabled, false, 'a usable address stages as before')
  assert.equal(view.el.dataset.settingsSaveState, 'pending')

  type(field(), '')
  await settle()
  assert.notEqual(view.el.dataset.settingsSaveState, 'invalid', 'an empty address (not configured) is not refused by the page')
  assert.deepEqual(sets, [], 'nothing was written before Save')
})
