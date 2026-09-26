/* T1300: mount the real Settings route with a fresh Basic preference store.
 * Bridge answers and actions are inert. DOM structure and handler routing are
 * observed; CSS computation, geometry and native/provider execution are not.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn, Element } from './lib/dom-stand-in.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const dom = installDomStandIn()
const originalMatches = Element.prototype.matches
// The shared stand-in intentionally omits compound class/attribute selectors.
// Add just that DOM operation locally so production presence painting runs.
Element.prototype.matches = function (selector) {
  const compound = selector.match(/^(\.[A-Za-z0-9_-]+)(\[[^\]]+\])$/)
  return compound
    ? originalMatches.call(this, compound[1]) && originalMatches.call(this, compound[2])
    : originalMatches.call(this, selector)
}
after(() => { Element.prototype.matches = originalMatches; dom.restore() })
const cells = new Map(), calls = []
let presence = []
globalThis.localStorage = {
  getItem: key => cells.get(key) ?? null,
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: key => cells.delete(key),
}
globalThis.CustomEvent = class {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail }
}
document.getElementById = id => document.body.querySelector('#' + id)
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.location = window.location = { hash: '#/settings' }
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) })
window.mcProviders = {
  presence: async () => ({ ok: true, providers: presence.map(row => ({ ...row })) }),
  accounts: async () => ({ ok: true, accounts: [], active: null }),
  detectLocal: async () => ({ ok: true, runtimes: [] }),
  onLoginEvent: () => () => {},
  installSnapshot: async () => ({ ok: false }),
  installStart: async args => { calls.push({ action: 'install', ...args }); return { ok: true } },
  loginStart: async args => { calls.push({ action: 'sign-in', ...args }); return { ok: true } },
  loginStop: async () => ({ ok: true }),
}
window.mcSettings = {
  read: async () => ({ ok: true, available: true, rows: [] }),
}
window.mcShell = {
  getBridgeProof: async () => ({ ok: false }),
  getBridgeEndpoint: async () => ({ ok: false }),
  getBridgeTransport: async () => ({ ok: false }),
}
const { resolveDataSource } = await import('../../src/data-source.js')
await resolveDataSource()
const { parseRoute } = await import('../../src/route-parse.js')
const { settingsView } = await import('../../src/views/settings.js')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }

for (const entry of [
  { hash: '#/settings', installed: [] },
  { hash: '#/settings?category=this-computer', installed: ['codex', 'claude'] },
]) {
  test(`fresh Basic ${entry.hash} exposes Install and Sign in through the mounted programs row`, async t => {
    cells.clear(); calls.length = 0
    presence = ['codex', 'claude', 'gemini'].map(id => ({
      id, installed: entry.installed.includes(id) ? 'yes' : 'no', signedIn: 'no',
    }))
    location.hash = entry.hash
    const route = parseRoute(location.hash)
    assert.equal(route.name, 'settings')
    assert.equal(route.query.has('setting'), false, 'no row-link bypass of Basic gating')
    const view = settingsView({ query: route.query, navigate() {} })
    document.body.appendChild(view.el)
    t.after(() => { view.destroy(); view.el.remove() })
    await settle()
    assert.equal(view.el.dataset.settingsMode, 'simple', 'an empty preference store selects Basic')
    assert.equal(view.el.dataset.settingsLanding, 'false', 'the row-link gate bypass is inactive')
    assert.equal(view.el.dataset.settingsSearch, 'false', 'the search gate bypass is inactive')
    const row = view.el.querySelector('[data-setting-id="this_computer_programs"]')
    assert.ok(row, 'first arrival mounts the programs row')
    assert.equal(row.dataset.settingsMinMode, 'simple', 'the actual row passes the Basic gate')
    assert.equal(row.closest('[hidden]'), null, 'no structural ancestor hides the programs row')
    const programs = row.querySelector('[data-this-computer-programs]')
    assert.ok(programs, 'the actual programs consumer is mounted inside the row')
    assert.equal(calls.length, 0, 'arriving starts no install or sign-in')
    for (const state of presence) {
      const panel = programs.querySelector(`[data-signin-provider="${state.id}"]`)
      assert.ok(panel, state.id + ' has a sign-in panel')
      assert.equal(panel.closest('[hidden]'), null, state.id + ' panel has been revealed')
      const install = panel.querySelector('[data-signin-install]')
      const signIn = panel.querySelector('[data-signin-start]')
      assert.ok(install, state.id + ' Install control is painted')
      assert.ok(signIn, state.id + ' Sign in control is painted')
      assert.equal(install.disabled, false)
      assert.equal(signIn.disabled, false, 'the available host verb handles sign-in readiness and refusal')
      assert.equal(install.closest('[hidden]'), null)
      assert.equal(signIn.closest('[hidden]'), null)
      install.click(); signIn.click()
      await settle()
    }
    assert.deepEqual(calls, presence.flatMap(state => [
      { action: 'install', provider: state.id, ...(state.installed === 'yes' ? { privateCopy: true } : {}) },
      { action: 'sign-in', provider: state.id },
    ]), 'the mounted controls route the selected provider to inert bridge handlers')
    assert.equal(cells.has('mc.settings.mode'), false, 'visiting never upgrades or saves the view mode')
  })
}

/* B15 (rehearsal-8 account drives, 2026-09-25): the one persistent door to
   #/account sat inside the System section, and the whole section was behind
   the Advanced gate, so a fresh Basic visit drew it 0x0. The CSS hides an
   Advanced panel's .settings-mode-content in Basic; this suite has no CSS, so
   it asserts the structure that CSS reads. Elements are asserted as booleans:
   a failing assert that prints one walks the whole stand-in tree. */
test('fresh Basic System draws the sign-in door outside the Advanced gate', async t => {
  cells.clear(); calls.length = 0
  presence = []
  location.hash = '#/settings?category=system'
  const route = parseRoute(location.hash)
  const view = settingsView({ query: route.query, navigate() {} })
  document.body.appendChild(view.el)
  t.after(() => { view.destroy(); view.el.remove() })
  await settle()
  assert.equal(view.el.dataset.settingsMode, 'simple', 'an empty preference store selects Basic')
  assert.equal(view.el.dataset.settingsSearch, 'false')
  assert.equal(view.el.dataset.settingsLanding, 'false')
  /* The stand-in reads no attribute value with a '#' in it, so the links are found by hand. */
  const doors = root => [...root.querySelectorAll('a')].filter(a => a.getAttribute('href') === '#/account')
  const door = doors(view.el)[0]
  assert.ok(Boolean(door), 'the System category draws the door to #/account')
  assert.ok(!door.closest('.settings-mode-content'), 'the door is not inside a mode-gated panel')
  assert.ok(!door.closest('[data-settings-min-mode]'), 'the door carries no minimum mode')
  assert.ok(!door.closest('[hidden]'), 'no structural ancestor hides the door')
  assert.ok(Boolean(door.closest('[data-profile-account]')), 'the door is in the sign-in section')
  const gated = [...view.el.querySelectorAll('.settings-mode-panel')]
    .find(panel => panel.dataset.settingsPanelMode === 'advanced' && panel.querySelector('[data-profile-system]'))
    ?.querySelector('.settings-mode-content')
  assert.ok(Boolean(gated?.querySelector('[data-profile-system]')), 'the fleet profile itself stays behind the Advanced gate')
  assert.equal(doors(view.el).length, 1, 'the door is drawn once')
  assert.equal(cells.has('mc.settings.mode'), false, 'visiting never upgrades or saves the view mode')
})
