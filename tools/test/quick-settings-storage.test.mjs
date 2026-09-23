import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createDocument, Element } from './lib/dom-stand-in.mjs'
import { fontStack } from '../../src/font-choice.js'

// Use the actual preference writers and actual control handlers. Only unrelated
// page/render imports are replaced; no storage, normalization or apply callback
// is replaced by a successful fake.
const dataSource = readFileSync(new URL('../../src/data-source.js', import.meta.url), 'utf8')
  .replace("import { bridgeTransportAvailable } from './mission-bridge.js'", 'const bridgeTransportAvailable = () => false')
const dataSourceUrl = `data:text/javascript,${encodeURIComponent(dataSource)}`
const computers = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const rangeStart = computers.indexOf('export function rangeFill(input) {')
const rangeEnd = computers.indexOf('\n}', rangeStart) + 2
assert.ok(rangeStart >= 0 && rangeEnd > rangeStart)
let source = readFileSync(new URL('../../src/quick-settings.js', import.meta.url), 'utf8')
  .replace("import './home-status-colors.css'", '')
  .replace("import { rangeFill } from './views/computers.js'", computers.slice(rangeStart, rangeEnd).replace('export ', ''))
  .replace("import { guidanceMarkup } from './guided-step.js'", "const guidanceMarkup = () => ''")
  .replace("import { phoneCanvasOn } from './phone-canvas.js'", 'const phoneCanvasOn = () => false')
  .replace(/import \{\s*readPhoneLedgerChoice,\s*setPhoneLedgerChoice,\s*\} from '\.\/phone-ledger\.js'/,
    "const readPhoneLedgerChoice = () => 'off'; const setPhoneLedgerChoice = () => null")
  .replace("from './data-source.js'", `from ${JSON.stringify(dataSourceUrl)}`)
for (const file of ['theme-choice.js', 'appearance-persistence.js', 'font-choice.js', 'text-size.js', 'agent-api-setting.js', 'audit-performance-settings.js', 'settings-numeric.js', 'home-status-quick-settings.js', 'home-circle-choice.js', 'home-circle-playful-moment.js']) {
  source = source.replace(`from './${file}'`, `from ${JSON.stringify(new URL(`../../src/${file}`, import.meta.url).href)}`)
}
const { renderQuickSettings } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
const { isExampleMode } = await import(dataSourceUrl)

function fixture({ seed = {}, glow = 100, motion = false, routeName = 'home', settings } = {}) {
  const previous = new Map(['document', 'window', 'localStorage', 'fetch', 'CustomEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  // This small stand-in deliberately omits tag[attr] selectors and reflected
  // range bounds. Supply only those DOM mechanics, never preference behavior.
  const elementDescriptors = new Map(['matches', 'min', 'max'].map(key => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)]))
  const baseMatches = Element.prototype.matches
  Element.prototype.matches = function (selector) {
    const tagged = typeof selector === 'string' && selector.match(/^([\w-]+)(\[[^\]]+\])$/)
    return tagged ? this.tagName === tagged[1].toUpperCase() && baseMatches.call(this, tagged[2]) : baseMatches.call(this, selector)
  }
  for (const name of ['min', 'max']) Object.defineProperty(Element.prototype, name, { configurable: true, get() { return this.getAttribute(name) ?? '' } })
  const document = createDocument(), values = new Map(Object.entries(seed)), operations = [], events = []
  let failure = null
  document.documentElement.dataset.theme = 'white'
  document.documentElement.style.setProperty('--glow', String(glow / 100))
  document.body.classList.toggle('reduce-motion', motion)
  const live = () => ({ theme: document.documentElement.dataset.theme,
    font: document.documentElement.style.getPropertyValue('--font-ui'), zoom: document.body.style.zoom || '',
    scale: document.documentElement.style.getPropertyValue('--zoom'), glow: document.documentElement.style.getPropertyValue('--glow'),
    motion: document.body.classList.contains('reduce-motion') })
  const storage = {
    getItem(key) { if (failure === 'read') throw new Error('Storage read refused'); return values.get(key) ?? null },
    setItem(key, value) { if (failure === key) throw new Error('Storage write refused'); operations.push({ kind: 'set', key, value: String(value), before: live() }); values.set(key, String(value)) },
    removeItem(key) { if (failure === key) throw new Error('Storage remove refused'); operations.push({ kind: 'remove', key, before: live() }); values.delete(key) },
  }
  const globals = { document, window: { mcSettings: settings, dispatchEvent: event => events.push(event) }, fetch: async () => ({ ok: false }),
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail } } }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { if (failure === 'access') throw new Error('Storage access refused'); return storage } })
  const body = document.createElement('div'); document.body.appendChild(body)
  const render = () => renderQuickSettings(body, routeName)
  render()
  return { body, values, operations, events, live, render, fail: value => { failure = value },
    node: selector => body.querySelector(selector),
    press(selector) { const button = body.querySelector(selector); assert.ok(button, selector); button.click() },
    error(id) { return body.querySelector(`[data-quick-error="${id}"]`) },
    restore() {
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
      for (const [key, descriptor] of elementDescriptors) { if (descriptor) Object.defineProperty(Element.prototype, key, descriptor); else delete Element.prototype[key] }
    },
  }
}

const cases = [
  { id: 'theme', key: 'mc.theme', value: 'black', run: f => f.press('[data-theme="black"]'), check: f => assert.equal(f.live().theme, 'black') },
  { id: 'font', key: 'mc.font', value: 'manrope', run: f => f.press('[data-font="manrope"]'), check: f => assert.equal(f.live().font, fontStack('manrope')) },
  { id: 'text', key: 'mc.text', value: '1.12', run: f => f.press('[data-text="1.12"]'), check: f => { assert.equal(f.live().zoom, '1.12'); assert.equal(f.live().scale, '1.12') } },
  { id: 'glow', key: 'mc.set.glow', value: '51', run: f => { const input = f.node('#set-glow'); input.value = '51'; input.dispatchEvent({ type: 'input' }) }, check: f => { assert.equal(f.live().glow, '0.51'); assert.equal(f.node('#set-glow').style.getPropertyValue('--fill'), '25.5%') } },
  { id: 'motion', key: 'mc.set.reduce_motion', value: 'true', run: f => { const input = f.node('#set-motion'); input.checked = true; input.dispatchEvent({ type: 'change' }) }, check: f => assert.equal(f.live().motion, true) },
  { id: 'example', key: 'mc.example', value: 'on', run: f => { const input = f.node('[data-quick-example]'); input.checked = true; input.dispatchEvent({ type: 'change' }) }, check: () => assert.equal(isExampleMode(), true) },
]

for (const entry of cases) test(`${entry.id}: failed save preserves prior live/control state, then a retry stores before applying and announces once`, () => {
  const f = fixture()
  try {
    assert.equal(f.operations.length, 0, 'opening quick settings writes nothing')
    const previous = f.live()
    f.fail(entry.key); entry.run(f)
    assert.deepEqual(f.live(), previous)
    assert.equal(f.values.has(entry.key), false)
    assert.equal(f.events.length, 0)
    assert.equal(f.error(entry.id).hidden, false)
    assert.match(f.error(entry.id).textContent, /could not be saved.*Try again/)
    if (entry.id === 'motion') assert.equal(f.node('#set-motion').checked, false)
    if (entry.id === 'example') { assert.equal(f.node('[data-quick-example]').checked, false); assert.equal(isExampleMode(), false) }
    if (entry.id === 'glow') { assert.equal(f.node('#set-glow').value, '100'); assert.equal(f.node('#set-glow').style.getPropertyValue('--fill'), '50%') }
    f.fail(null); entry.run(f)
    assert.equal(f.values.get(entry.key), entry.value)
    assert.equal(f.operations.length, 1)
    assert.deepEqual(f.operations[0].before, previous, 'durable write must precede document mutation')
    entry.check(f)
    assert.equal(f.error(entry.id).hidden, true)
    assert.equal(f.events.filter(event => event.type === 'mc:quick-setting-changed').length, 1)
  } finally { f.restore() }
})

test('returning glow, motion and example to defaults preserves non-default values when removal fails', () => {
  const f = fixture({ seed: { 'mc.set.glow': '51', 'mc.set.reduce_motion': 'true', 'mc.example': 'on' }, glow: 51, motion: true })
  try {
    const choices = [
      ['mc.set.glow', '#set-glow', node => { node.value = '100'; node.dispatchEvent({ type: 'input' }) }],
      ['mc.set.reduce_motion', '#set-motion', node => { node.checked = false; node.dispatchEvent({ type: 'change' }) }],
      ['mc.example', '[data-quick-example]', node => { node.checked = false; node.dispatchEvent({ type: 'change' }) }],
    ]
    for (const [key, selector, change] of choices) {
      const previous = f.live(); f.fail(key); change(f.node(selector))
      assert.deepEqual(f.live(), previous); assert.ok(f.values.has(key)); assert.equal(f.events.length, 0)
    }
    assert.equal(f.node('#set-glow').value, '51'); assert.equal(f.node('#set-motion').checked, true); assert.equal(f.node('[data-quick-example]').checked, true)
    f.fail(null)
    for (const [, selector, change] of choices) change(f.node(selector))
    assert.equal(f.values.size, 0); assert.equal(f.operations.length, 3)
    assert.ok(f.operations.every(operation => operation.kind === 'remove'))
    assert.equal(f.live().glow, '1'); assert.equal(f.live().motion, false); assert.equal(isExampleMode(), false)
  } finally { f.restore() }
})

test('unreadable storage leaves an explicit unavailable example control and reopening can recover', () => {
  const f = fixture()
  try {
    f.fail('read'); f.render()
    assert.equal(f.node('[data-quick-example]').disabled, true)
    assert.equal(f.node('[data-quick-example]').indeterminate, true)
    assert.match(f.error('example').textContent, /could not be read.*Reopen/)
    f.fail('access'); f.press('[data-font="manrope"]')
    assert.equal(f.live().font, ''); assert.equal(f.error('font').hidden, false)
    f.fail(null); f.render()
    assert.equal(f.node('[data-quick-example]').disabled, false)
    assert.equal(f.error('example').hidden, true)
    assert.equal(f.operations.length, 0)
  } finally { f.restore() }
})

test('malformed segmented values write nothing and do not change the current visual choice', () => {
  const f = fixture()
  try {
    const previous = f.live()
    for (const [selector, name, value] of [['[data-theme="black"]', 'theme', 'unknown'], ['[data-font="manrope"]', 'font', 'unknown'], ['[data-text="1.12"]', 'text', '1.12wrong']]) {
      const button = f.node(selector); button.dataset[name] = value; button.click()
    }
    assert.deepEqual(f.live(), previous); assert.equal(f.operations.length, 0); assert.equal(f.events.length, 0)
  } finally { f.restore() }
})

test('Computer drawer toggles Optimized API through the actual markup and reopens with saved choices', async () => {
  const saved = new Map([['agent.tool_summary', true], ['agent.capability_recall', false]])
  const writes = []
  let reads = 0, refuse = false
  const f = fixture({ routeName: 'computers', settings: {
    async read() {
      reads++
      return { ok: true, available: true, rejected: [], rows: [
        { id: 'agent.agent_api', present: true, control: 'seg', options: ['Only', 'Enabled', 'Disabled'], value: 'Only' },
        ...[...saved].map(([id, value]) => ({ id, value, present: true, control: 'toggle' })),
      ] }
    },
    async set(id, value) {
      writes.push({ id, value })
      if (refuse) return { ok: false }
      saved.set(id, value)
      return { ok: true, id, value }
    },
  } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const row = id => f.node(`[data-agent-api-discovery="${id}"]`)
  try {
    assert.equal(writes.length, 0, 'opening the drawer does not write settings')
    assert.equal(row('agent.tool_summary').indeterminate, true)
    await tick()
    assert.equal(reads, 2, 'the existing API and audit panels each read once; discovery adds no read')
    assert.equal(row('agent.tool_summary').checked, true)
    assert.equal(row('agent.capability_recall').checked, false)
    for (const [id, value] of [['agent.tool_summary', false], ['agent.capability_recall', true]]) {
      const input = row(id)
      assert.equal(input.disabled, false)
      input.checked = value
      input.dispatchEvent({ type: 'change' })
      assert.equal(input.disabled, true)
      await tick()
      assert.equal(input.checked, value)
      assert.equal(input.disabled, false)
    }
    assert.deepEqual(writes, [{ id: 'agent.tool_summary', value: false }, { id: 'agent.capability_recall', value: true }])
    f.render(); await tick()
    assert.equal(row('agent.tool_summary').checked, false)
    assert.equal(row('agent.capability_recall').checked, true)
    refuse = true
    const input = row('agent.capability_recall')
    input.checked = false; input.dispatchEvent({ type: 'change' }); await tick()
    assert.equal(input.indeterminate, true)
    assert.equal(input.disabled, true)
    assert.equal(saved.get('agent.capability_recall'), true, 'a refusal never invents a saved choice')
    assert.match(f.node('[data-agent-api-discovery-status="agent.capability_recall"]').textContent, /Could not confirm/)
  } finally { f.restore() }
})
