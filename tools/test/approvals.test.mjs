/* The approvals view owns the last, human-visible gate on a decision. Drive
 * the exported factory with the same zero-argument call used by main.js and
 * let the shared DOM stand-in parse the production template. */

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
 * one-unit screen. */
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

const proof = 'approvals-view-proof'.padEnd(43, '0')
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
  { ledgerPromptQueue },
  { resetBridgeSession },
  { exampleOwnerPrompts, APPROVALS_EXAMPLE_MARKING },
  { GENERIC_REMEDY },
] = await Promise.all([
  import('../../src/ledger-prompt-queue.js'),
  import('../../src/mission-bridge.js'),
  import('../../src/approvals-example.js'),
  import('../../src/refusal-copy.js'),
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

async function mounted({ example = false, snapshotReply = snapshot() } = {}) {
  document.body.replaceChildren()
  globalThis.localStorage = { getItem: key => (example && key === 'mc.example' ? 'on' : null) }
  activeSnapshotReply = snapshotReply
  resetBridgeSession()
  const view = ledgerPromptQueue()
  document.body.appendChild(view.el)
  await settle()
  return {
    view,
    restore() {
      view.destroy()
      view.el.remove()
      resetBridgeSession()
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

test('example requests stay disabled and carry the canonical example status', async () => {
  const rig = await mounted({ example: true })
  try {
    const cards = rig.view.el.querySelectorAll('.approvals-card')
    assert.equal(cards.length, exampleOwnerPrompts().length, 'the production example queue did not paint every owned request')
    for (const card of cards) {
      const controls = card.querySelectorAll('button')
      assert.ok(controls.length > 0, `example ${card.dataset.promptId} has no decision control`)
      assert.equal(controls.every(control => control.disabled === true), true, `example ${card.dataset.promptId} exposed a live decision control`)
      assert.equal(card.querySelector('.owner-popup-status').textContent, APPROVALS_EXAMPLE_MARKING.cardStatus,
        `example ${card.dataset.promptId} did not carry its owner-provided status`)
    }
  } finally { rig.restore() }
})

test('a presented live request enables exactly two controls and exposes ready state', async () => {
  const rig = await mounted()
  try {
    const card = rig.view.el.querySelector('.approvals-card')
    assert.equal(card.dataset.promptId, prompt().id, 'the queue response did not reach the rendered card')
    const status = card.querySelector('.owner-popup-status')
    assert.equal(status.getAttribute('data-state'), 'status', 'the presented request did not enter status state')
    assert.equal(status.getAttribute('role'), 'status', 'the presented request lost its status role')
    assert.equal(status.getAttribute('aria-live'), 'polite', 'the presented request lost its polite live region')
    const controls = card.querySelectorAll('button')
    assert.equal(controls.length, 2, 'the confirmation must offer both caller-visible decisions')
    assert.equal(controls.every(control => control.disabled === false), true, 'a presented live request kept its decision controls disabled')
  } finally { rig.restore() }
})

test('a failed queue read is unknown, never an empty queue or a definite total', async () => {
  const rig = await mounted({ snapshotReply: { ok: false, reason: GENERIC_REMEDY } })
  try {
    const waiting = rig.view.el.querySelector('[data-summary="waiting"]')
    const purchases = rig.view.el.querySelector('[data-summary="purchases"]')
    assert.ok(waiting, 'the waiting summary is absent')
    assert.ok(purchases, 'the purchases summary is absent')
    assert.notEqual(waiting, purchases, 'attribute-value matching returned one node for two summaries')
    assert.equal(waiting.getAttribute('data-summary'), 'waiting', 'the waiting query ignored its requested attribute value')
    assert.equal(purchases.getAttribute('data-summary'), 'purchases', 'the purchases query ignored its requested attribute value')
    assert.equal(waiting.textContent, '—', 'an unreadable queue was reported as a definite count')
    assert.equal(purchases.textContent, '—', 'unreadable purchases were reported as a definite total')
    assert.equal(rig.view.el.querySelectorAll('.approvals-card').length, 0, 'an unreadable response left decision controls on screen')
  } finally { rig.restore() }
})

test('shared replaceChildren detaches independently-created removed children', () => {
  const parent = document.createElement('div')
  const oldChild = document.createElement('span')
  const newChild = document.createElement('strong')
  parent.appendChild(oldChild)
  parent.replaceChildren(newChild)
  assert.deepEqual(parent.children, [newChild], 'replaceChildren did not leave only the independent replacement')
  assert.equal(oldChild.parentNode, null, 'replaceChildren left the removed child connected to its former parent')
})
