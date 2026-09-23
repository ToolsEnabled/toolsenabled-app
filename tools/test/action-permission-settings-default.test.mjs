import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import {
  createActionPermissionSettings,
  defaultAgentResumeMode,
  resolveAgentResumeMode,
} from '../../src/action-permission-settings.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const receipt = id => ({ id, atMs: 1790075761542 })
const rootProfile = actions => ({ id: 'root', name: 'Root', parentId: null, actions, functions: null })
const childProfile = actions => ({ id: 'child', name: 'Child', parentId: 'root', actions, functions: null })

test('the saved working-profile receipt selects the engine default only when agentResume is absent', () => {
  for (const id of ['independent', 'autonomous', 'autonomous-plus']) {
    assert.equal(defaultAgentResumeMode(receipt(id)), 'automatic', id)
    assert.equal(resolveAgentResumeMode(rootProfile({}), receipt(id)).mode, 'automatic', id)
  }
  for (const id of ['locked', 'careful', 'balanced']) {
    assert.equal(defaultAgentResumeMode(receipt(id)), 'direct', id)
    assert.equal(resolveAgentResumeMode(rootProfile({}), receipt(id)).mode, 'direct', id)
  }
  assert.equal(resolveAgentResumeMode(rootProfile({}), receipt('future-profile')).source, 'engine-fallback')
  assert.equal(resolveAgentResumeMode(rootProfile({}), { id: 'independent' }).mode, 'direct')
  assert.equal(resolveAgentResumeMode(rootProfile({ agentResume: 'disabled' }), receipt('independent')).mode, 'disabled')
  assert.equal(resolveAgentResumeMode(rootProfile({ agentResume: 'direct' }), receipt('independent')).mode, 'direct')
  assert.equal(resolveAgentResumeMode(childProfile({}), receipt('independent')).mode, '')
  assert.equal(resolveAgentResumeMode(childProfile({ agentResume: 'automatic' }), receipt('balanced')).mode, 'automatic')
})

test('mounted permission markup updates from the committed receipt without creating an override', () => {
  let pending = {
    v: 1,
    activeProfileId: 'root',
    profiles: [rootProfile({})],
  }
  const staged = []
  let committedReceipt = null
  const handlers = new Map()
  let paintCount = 0
  let mountedSelect = null
  const sourceNode = { textContent: '' }
  const panel = {}
  Object.defineProperty(panel, 'outerHTML', {
    get() { return panel.rendered },
    set(value) { paintCount += 1; panel.rendered = value },
  })
  const fixture = {
    addEventListener(name, handler) { handlers.set(name, handler) },
    removeEventListener() {},
    querySelector(selector) {
      if (selector === '[data-action-permissions]') return panel
      if (selector === '[data-permission-agent-resume-source]') return sourceNode
      if (selector === '[data-permission-mode="agentResume"]') return mountedSelect
      return panel
    },
  }
  const controller = createActionPermissionSettings({
    draft: {
      value(key, fallback) { return key === 'permissions:profiles' ? pending : fallback },
      stage(key, value) { staged.push({ key, value }); pending = value },
    },
    readWorkingProfileReceipt: () => committedReceipt,
    storage: { getItem: () => null, setItem() {} },
  })
  controller.bind(fixture)
  assert.match(controller.markup(), /value="direct" selected/)
  assert.match(controller.markup(), /Direct user request, the default when no working profile is saved\./)
  committedReceipt = receipt('independent')
  controller.repaint()
  assert.match(controller.markup(), /value="automatic" selected/)
  assert.match(controller.markup(), /Automatic, from your saved Independent working profile\./)
  sourceNode.textContent = 'Automatic, from your saved Independent working profile.'

  handlers.get('change')({ target: {
    closest: () => fixture,
    matches: selector => selector === '[data-permission-mode]',
    dataset: { permissionMode: 'agent.status' },
    value: 'direct',
  } })
  assert.equal(staged.length, 1)
  assert.equal(staged[0].key, 'permissions:profiles')
  assert.equal(Object.hasOwn(staged[0].value.profiles[0].actions, 'agentResume'), false)
  assert.equal(staged[0].value.profiles[0].actions['agent.status'], 'direct')

  const focusedSelect = {
    closest: () => fixture,
    matches: selector => selector === '[data-permission-mode]',
    dataset: { permissionMode: 'agentResume' },
    value: 'disabled',
  }
  mountedSelect = focusedSelect
  const paintCountBeforeMode = paintCount
  handlers.get('change')({ target: focusedSelect })
  assert.equal(sourceNode.textContent, 'Chosen in this permission profile.')
  assert.equal(mountedSelect, focusedSelect)
  assert.equal(paintCount, paintCountBeforeMode)
  assert.equal(staged.length, 2)
  assert.equal(staged[1].value.profiles[0].actions.agentResume, 'disabled')
  controller.destroy()
})

/* The real Settings page: the resume row reads the receipt from the working
   profile's own host read (mcSettings.read().workingProfile), the value the
   engine's effective() uses, and repaints when that read lands. */
test('mounted Settings shows the saved working profile default on the resume row', async t => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn()
  const cells = new Map([['mc.settings.mode', 'expert']])
  const saved = { workingProfile: null }
  const previous = {
    localStorage: globalThis.localStorage, CustomEvent: globalThis.CustomEvent, location: globalThis.location,
    fetch: globalThis.fetch, confirm: globalThis.confirm,
  }
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
  const hadOuter = Object.getOwnPropertyDescriptor(elementPrototype, 'outerHTML')
  if (!hadOuter) {
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
  window.mcSettings = {
    stagesWrites: true,
    read: async () => ({ ok: true, available: true, rows: [], workingProfile: saved.workingProfile }),
    set: async (_id, value) => ({ ok: true, value }),
  }
  t.after(() => {
    if (!hadOuter) delete elementPrototype.outerHTML
    Object.assign(globalThis, previous)
    dom.restore()
  })
  const settle = async (turns = 16) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)) }
  const { resolveDataSource } = await import('../../src/data-source.js')
  await resolveDataSource()
  const { settingsView } = await import('../../src/views/settings.js')
  const { categorySlug } = await import('../../src/settings-presentation.js')
  async function resumeRowFor(workingProfile) {
    saved.workingProfile = workingProfile
    const view = settingsView({ query: new URLSearchParams({ category: categorySlug('App permissions') }), navigate() {} })
    document.body.appendChild(view.el)
    await settle()
    const select = view.el.querySelector('[data-permission-mode="agentResume"]')
    assert.ok(select, 'the real Agent permission profiles section is mounted')
    const chosen = select.children.find(option => option.hasAttribute('selected'))
    const sentence = view.el.querySelector('[data-permission-agent-resume-source]')?.textContent
    view.destroy()
    view.el.remove()
    return { value: chosen?.getAttribute('value'), sentence }
  }
  for (const id of ['independent', 'autonomous', 'autonomous-plus']) {
    const row = await resumeRowFor(receipt(id))
    assert.equal(row.value, 'automatic', id + ' saved: the row shows what the engine does')
    assert.match(row.sentence, /^Automatic, from your saved .+ working profile\.$/, id)
  }
  const balanced = await resumeRowFor(receipt('balanced'))
  assert.equal(balanced.value, 'direct')
  assert.equal(balanced.sentence, 'Direct user request, from your saved Balanced working profile.')
  const none = await resumeRowFor(null)
  assert.equal(none.value, 'direct')
  assert.equal(none.sentence, 'Direct user request, the default when no working profile is saved.')
  assert.equal(cells.has('mc.action-permissions.v1'), false, 'showing the default writes no permission profile')
})
