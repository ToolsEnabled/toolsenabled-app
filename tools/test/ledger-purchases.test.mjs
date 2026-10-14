/* The ledger's P tab is a MOUNT of approvals.js's card renderer, not a
 * rewrite (LEDGER-KINDS-INTERFACE-20260907.md, RULINGS 04:47Z). This drives
 * renderPurchasesTab() the way src/views/ledger.js's syncPurchasesMount()
 * drives ledgerPromptQueue(), and proves the three things a flattening into
 * plain ledger rows could not carry: the presentation-verification handshake
 * survives, per-line purchase detail survives, and a purchase id never
 * reaches src/ledger-row-actions.js's row-action grammar. It also proves the
 * one new thing this module adds: a checkout link gated on
 * checkoutSurfaceAvailable(). */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as defer } from 'node:timers/promises'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const domModuleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn, Element, ClassList } = await import(domModuleUrl)
assert.equal(typeof installDomStandIn, 'function')
assert.equal(typeof Element, 'function')
assert.equal(typeof ClassList, 'function')

const installed = installDomStandIn(globalThis)
const { document } = installed
const localGlobalNames = ['localStorage', 'fetch', 'setInterval', 'clearInterval']
const localDescriptors = new Map(localGlobalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const originalRectangle = Element.prototype.getBoundingClientRect
const originalOffsetParent = Object.getOwnPropertyDescriptor(Element.prototype, 'offsetParent')

/* Layout is not part of the shared stand-in. The real presentation code gets
 * the smallest positive, layout-neutral proof that a mounted card is on a
 * one-unit screen -- same rig as tools/test/approvals.test.mjs. */
Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 }
}
Object.defineProperty(Element.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? this.parentNode : null } })
document.defaultView = {
  innerWidth: 1,
  innerHeight: 1,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
}
document.hasFocus = () => true
document.querySelector = () => null
document.getElementById = () => null
document.documentElement.setAttribute('data-theme', 'white')
window.document = document
window.location = { search: '?bridge=http%3A%2F%2F127.0.0.1%3A4610', hostname: '127.0.0.1' }
window.innerWidth = 1
window.innerHeight = 1
window.getComputedStyle = document.defaultView.getComputedStyle
window.requestAnimationFrame = callback => { queueMicrotask(callback); return 1 }
window.cancelAnimationFrame = () => {}

globalThis.localStorage = { getItem: () => null }
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame

const proof = 'ledger-purchases-proof'.padEnd(43, '0')
window.mcShell = { getBridgeProof: async () => ({ ok: true, proof }) }

let activeSnapshotReply = null
globalThis.fetch = async url => {
  if (String(url).includes('/v1/bootstrap')) return { ok: true, status: 200, json: async () => ({ ok: true, token: 'fixture-token' }) }
  if (String(url).endsWith('/v1/owner-prompts')) return activeSnapshotReply?.ok === false
    ? { ok: false, status: 503, json: async () => ({ error: { message: activeSnapshotReply.reason } }) }
    : { ok: true, status: 200, json: async () => activeSnapshotReply }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

const [
  { renderPurchasesTab },
  { resetBridgeSession },
  { exampleOwnerPrompts },
  { __setCheckoutSurfaceForTest },
  { mountLedgerRowActions },
] = await Promise.all([
  import('../../src/views/ledger-purchases.js'),
  import('../../src/mission-bridge.js'),
  import('../../src/approvals-example.js'),
  import('../../src/checkout-visibility.js'),
  import('../../src/ledger-row-actions.js'),
])

const palette = () => ({ bg: '0', bg2: '0', surface: '0', sheet: '0', ink: '0', ink2: '0',
  ink25: '0', ink3: '0', line: '0', line2: '0', good: '0', serious: '0' })
const theme = () => ({
  schemaVersion: 1,
  defaultTheme: 'white',
  fonts: { ui: '0', mono: '0', nativeUiFamilies: ['0'], nativeMonoFamilies: ['0'] },
  metrics: { radiusSmall: 0, radiusMedium: 0, radiusLarge: 0, space1: 0, space2: 0, space3: 0, space4: 0, space5: 0 },
  common: { accent: '0', accentFloor: '0', focus: '0', onAccent: '0' },
  roles: { coordinator: '0', helper: '0', shadow: '0', manager: '0' },
  themes: { white: palette(), tan: palette(), black: palette() },
})

const canonicalConfirmation = exampleOwnerPrompts(Date.parse('2026-08-25T12:00:00.000Z'))
  .find(candidate => candidate.kind === 'confirmation')
const prompt = () => ({
  ...canonicalConfirmation,
  id: 'prompt-0001',
  createdAt: '2026-08-25T11:00:00.000Z',
  expiresAt: '2026-08-28T11:00:00.000Z',
})
const snapshot = () => ({ ok: true, schemaVersion: 1, generatedAt: '2026-08-25T12:00:00.000Z', theme: theme(), prompts: [prompt()] })
async function settle() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); await defer() }

async function mountTab({ example = false, snapshotReply = snapshot(), checkoutAvailable = false } = {}) {
  document.body.replaceChildren()
  globalThis.localStorage = { getItem: key => (example && key === 'mc.example' ? 'on' : null) }
  activeSnapshotReply = snapshotReply
  resetBridgeSession()
  __setCheckoutSurfaceForTest(checkoutAvailable, true)
  const container = document.createElement('section')
  document.body.appendChild(container)
  const handle = renderPurchasesTab(container, {})
  await settle()
  return {
    container,
    handle,
    restore() {
      handle.destroy()
      container.remove()
      resetBridgeSession()
      __setCheckoutSurfaceForTest(false, false)
    },
  }
}

after(() => {
  document.body.replaceChildren()
  delete document.defaultView
  delete document.hasFocus
  delete document.querySelector
  delete document.getElementById
  Element.prototype.getBoundingClientRect = originalRectangle
  if (originalOffsetParent) Object.defineProperty(Element.prototype, 'offsetParent', originalOffsetParent)
  else delete Element.prototype.offsetParent
  for (const name of localGlobalNames) {
    const descriptor = localDescriptors.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  installed.restore()
})

test('mounts the approvals card renderer intact: the presentation handshake enables a presented card', async () => {
  const rig = await mountTab()
  try {
    const card = rig.container.querySelector('.approvals-card')
    assert.ok(card, 'renderPurchasesTab did not mount an approvals card')
    assert.equal(card.dataset.promptId, prompt().id, 'the queue response did not reach the rendered card')
    const controls = card.querySelectorAll('button')
    assert.equal(controls.length, 2, 'the confirmation must offer both caller-visible decisions')
    assert.equal(controls.every(control => control.disabled === false), true,
      'the presentation-verification handshake did not enable a presented card\'s controls through the mount')
  } finally { rig.restore() }
})

test('per-line purchase detail (merchant, purpose, amount) survives the mount', async () => {
  const rig = await mountTab({ example: true })
  try {
    const items = rig.container.querySelectorAll('.owner-popup-item')
    assert.ok(items.length > 0, 'no per-line purchase detail was drawn through the mount')
    const metaLabels = items.map(item => [...item.querySelectorAll('.owner-popup-meta-label')].map(label => label.textContent))
    assert.ok(metaLabels.some(labels => labels.includes('Merchant')), 'a purchase line lost its Merchant label through the mount')
    assert.ok(metaLabels.some(labels => labels.includes('Purpose')), 'a purchase line lost its Purpose label through the mount')
    const amounts = rig.container.querySelectorAll('.owner-popup-item-amount')
    assert.ok(amounts.length > 0, 'a purchase line lost its per-line amount through the mount')
  } finally { rig.restore() }
})

test('checkout link is drawn only when checkoutSurfaceAvailable() is true', async () => {
  const off = await mountTab({ checkoutAvailable: false })
  try {
    // Compared as a boolean, never the element itself: an Element carries a
    // circular parentNode chain and a Proxy-backed dataset, so handing a live
    // node to assert.equal() as `actual` makes a FAILING run hang inside
    // util.inspect's diff instead of failing cleanly.
    assert.equal(off.container.querySelector('.ledger-purchases-checkout-link') === null, true,
      'a checkout link was drawn while checkoutSurfaceAvailable() was false')
  } finally { off.restore() }

  const on = await mountTab({ checkoutAvailable: true })
  try {
    const link = on.container.querySelector('.ledger-purchases-checkout-link')
    assert.ok(link, 'no checkout link was drawn while checkoutSurfaceAvailable() was true')
    assert.equal(link.getAttribute('href'), '#/checkout', 'the checkout link did not point at #/checkout')
  } finally { on.restore() }
})

test('destroy() tears down the approvals instance and empties the container', async () => {
  const rig = await mountTab()
  assert.ok(rig.container.firstChild, 'nothing was mounted to tear down')
  rig.handle.destroy()
  // Same reason as the checkout-link test: compare as a boolean, never hand a
  // live node to assert.equal() where a failure would try to inspect it.
  assert.equal(rig.container.firstChild === null, true, 'destroy() left content behind in the container')
  rig.container.remove()
  resetBridgeSession()
})

test('a purchase id never reaches ledger-row-actions.js: its own SAFE_ID grammar refuses P, with a T positive control proving the harness can reach the bridge', () => {
  const rowRegister = document.createElement('div')
  document.body.appendChild(rowRegister)

  function rowWithButton(id) {
    const record = document.createElement('div')
    record.className = 'ledger-record'
    record.dataset.rowId = id
    const button = document.createElement('button')
    button.dataset.rowAction = 'complete'
    button.dataset.id = id
    record.appendChild(button)
    rowRegister.appendChild(record)
    return button
  }

  const purchaseButton = rowWithButton('P1')
  const taskButton = rowWithButton('T1')

  const calls = []
  const bridge = { completeTask: async ({ id }) => { calls.push(id); return { ok: true } } }
  const handle = mountLedgerRowActions(rowRegister, { bridge })

  handle.press({ target: purchaseButton })
  assert.deepEqual(calls, [], 'a P id reached ledger-row-actions.js\'s bridge dispatch')

  handle.press({ target: taskButton })
  assert.deepEqual(calls, ['T1'], 'the positive control (a T id, same action, same bridge) did not reach the bridge -- the harness itself would be broken, not just the P refusal')

  handle.destroy()
  rowRegister.remove()
})
