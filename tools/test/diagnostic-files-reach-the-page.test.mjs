/* THE DIAGNOSTIC FILES PANEL IS ON THE PAGE (owner direction 2026-09-20,
 * T782/T783). The panel module has its own suite (diagnostic-settings.test.mjs);
 * this one drives settingsView() itself, the way
 * settings-compare-files-row-reaches-the-page.test.mjs does, and reads what it
 * painted: the panel sits in Data & Privacy behind the Advanced gate, beside
 * the Diagnostic retention row it belongs to; a search for what it does finds
 * it; the page reads the first page of files through the window's own
 * mcSettings bridge after it has been painted; and leaving the view stops
 * every later answer from painting anything.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const stored = new Map()
const listeners = new Map()
let painted = ''

const classList = () => ({ add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false })
function node() {
  return {
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    classList: classList(),
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, toggleAttribute: () => {},
    getAttribute: () => null, querySelector: () => node(), querySelectorAll: () => [],
    closest: () => null, contains: () => true, children: [],
    appendChild(child) { this.children.push(child); return child },
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }],
    scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
Object.defineProperty(sections, 'innerHTML', { get: () => painted, set: value => { painted = String(value) } })
/* The panel repaints itself through root.querySelector('[data-diagnostic-files]')
   .outerHTML; this stub records those repaints so a late one can be seen. */
const panel = { outerHTML: '' }
/* The search box: the view listens to its input event and reads its value. */
const searchInput = node()
const searchListeners = {}
searchInput.addEventListener = (type, listener) => { searchListeners[type] = listener }
const root = node()
root.querySelector = selector => (selector === '.settings-sections' ? sections : selector === '[data-diagnostic-files]' ? panel : selector === '.settings-search input' ? searchInput : node())
root.querySelectorAll = () => []

globalThis.document = {
  createElement: () => ({ set innerHTML(value) { this.value = value }, content: { firstElementChild: root } }),
  documentElement: node(), body: node(), getElementById: () => null,
}
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
}
const inspects = []
let answer = () => ({ ok: true, reason: null, complete: true, scanComplete: true, unknownCount: 0, entriesThisPage: 1, managedBytes: 2048, protectedBytes: 0, budgetMet: true,
  files: [{ id: 'd-1', kind: 'main-lag', pid: 1, createdAt: Date.UTC(2026, 8, 20), bytes: 2048, active: false, keep: false, archive: false, outputSuppressed: null }] })
globalThis.window = {
  addEventListener: (type, listener) => {
    const group = listeners.get(type) || new Set()
    group.add(listener)
    listeners.set(type, group)
  },
  removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  dispatchEvent: event => { for (const listener of listeners.get(event.type) || []) listener(event); return true },
  matchMedia: () => ({ matches: false }),
  /* The page reads product rows through the same bridge; an empty answer is
     enough for the section to paint. */
  mcSettings: {
    read: async () => ({ ok: true, available: true, rows: [] }),
    set: async () => ({ ok: false, reason: 'not in this fixture' }),
    setMany: async () => ({ ok: false, results: [], reason: 'not in this fixture' }),
    diagnosticsInspect: async request => { inspects.push({ ...request }); return answer() },
  },
}
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { settingsView } = await import('../../src/views/settings.js')
const { categorySlug } = await import('../../src/settings-presentation.js')
const { productSettingPresentation } = await import('../../src/product-settings-layout.js')
const { sectionOfRow } = await import('../../src/research-settings.js')

const settle = () => new Promise(resolve => setImmediate(resolve))

function paint(query) {
  painted = ''
  panel.outerHTML = ''
  const view = settingsView({ query, navigate: () => {} })
  return { markup: painted, view }
}

test('the panel is painted in Data & Privacy, behind the Advanced gate, in the section that owns the retention row', async () => {
  assert.equal(sectionOfRow('diagnostics.retention'), 'Data & Privacy', 'the retention row and its files live in the same section')
  assert.equal(productSettingPresentation('diagnostics.retention').mode, 'advanced')
  const { markup, view } = paint(new URLSearchParams({ category: categorySlug('Data & Privacy') }))
  assert.match(markup, /data-settings-section="Data &amp; Privacy"/)
  const gate = markup.match(/<section class="settings-mode-gate">\s*<h2 class="settings-section-title">Diagnostic files<\/h2>[\s\S]*?data-settings-show-mode="advanced"/)
  assert.ok(gate, 'the panel is gated behind Advanced with a Show Advanced press, like the Transcript archive beside it')
  assert.match(markup, /data-diagnostic-files/, 'the panel content is on the page inside the gate')
  assert.match(markup, /Diagnostic files<\/h2>\s*<p>Routine product diagnostics kept on this computer under your Diagnostic retention choice/)
  assert.ok(markup.indexOf('data-transcript-settings') < markup.indexOf('data-diagnostic-files'), 'after the transcript archive')
  assert.ok(markup.indexOf('data-diagnostic-files') < markup.indexOf('Audit signing identity'), 'before the audit identity panel')
  await settle()
  assert.deepEqual(inspects, [{ next: false }], 'the first page is read once, after the paint, through the window\'s own bridge')
  assert.match(panel.outerHTML, /App stall record/, 'and the answer is painted into the panel')
  assert.match(panel.outerHTML, /data-diagnostic-keep="d-1"/)
  view.destroy?.()
})

test('a search for what the panel does finds it, and only then', () => {
  const { view } = paint(new URLSearchParams({ category: categorySlug('Appearance') }))
  assert.doesNotMatch(painted, /data-diagnostic-files/, 'another section does not carry the panel')
  const search = words => { searchInput.value = words; searchListeners.input(); return painted }
  assert.match(search('diagnostic files export archive'), /data-diagnostic-files/, 'the panel answers a search for its own words')
  assert.match(painted, /Diagnostic files<\/h2>/)
  assert.doesNotMatch(search('firewall port'), /data-diagnostic-files/, 'and stays out of a search that is not about it')
  view.destroy?.()
})

test('leaving the view stops a late answer from painting anything', async () => {
  let release
  answer = () => new Promise(resolve => { release = resolve })
  const { view } = paint(new URLSearchParams({ category: categorySlug('Data & Privacy') }))
  await settle()
  assert.ok(release, 'the read is in flight')
  view.destroy?.()
  panel.outerHTML = 'left as painted'
  release({ ok: true, files: [{ id: 'late', kind: 'main-lag', pid: 1, createdAt: 1, bytes: 1, active: false, keep: false, archive: false }], scanComplete: true, unknownCount: 0 })
  await settle()
  assert.equal(panel.outerHTML, 'left as painted', 'a destroyed view paints no late page')
})
