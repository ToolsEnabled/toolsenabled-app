// Real queue, reset controls and shared outcomes; only transport and layout are fixtures.
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { setImmediate as defer } from 'node:timers/promises'
import { installDomStandIn, Element } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const { ledgerPromptQueue } = await import('../../src/ledger-prompt-queue.js')
const { mountLedgerResetControls } = await import('../../src/ledger-reset-controls.js')
const { setBridgeTransport } = await import('../../src/mission-bridge.js')
const { exampleOwnerPrompts } = await import('../../src/approvals-example.js')
const outcomes = await import('../../src/approval-outcomes.js')

const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); await defer() }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const palette = () => Object.fromEntries(['bg', 'bg2', 'surface', 'sheet', 'ink', 'ink2', 'ink25', 'ink3', 'line', 'line2', 'good', 'serious'].map(key => [key, '0']))
const theme = {
  schemaVersion: 1, defaultTheme: 'white',
  fonts: { ui: '0', mono: '0', nativeUiFamilies: ['0'], nativeMonoFamilies: ['0'] },
  metrics: Object.fromEntries(['radiusSmall', 'radiusMedium', 'radiusLarge', 'space1', 'space2', 'space3', 'space4', 'space5'].map(key => [key, 0])),
  common: { accent: '0', accentFloor: '0', focus: '0', onAccent: '0' },
  roles: { coordinator: '0', helper: '0', shadow: '0', manager: '0' },
  themes: { white: palette(), tan: palette(), black: palette() },
}

async function fixture(t) {
  const dom = installDomStandIn()
  const doc = dom.document
  const globalKeys = ['localStorage', 'fetch', 'setInterval', 'clearInterval']
  const globals = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const rectangle = Element.prototype.getBoundingClientRect
  const offset = Object.getOwnPropertyDescriptor(Element.prototype, 'offsetParent')
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 })
  Object.defineProperty(Element.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? this.parentNode : null } })
  doc.defaultView = { innerWidth: 1, innerHeight: 1, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }
  doc.hasFocus = () => true
  doc.querySelector = () => null
  doc.getElementById = () => null
  doc.documentElement.setAttribute('data-theme', 'white')
  window.document = doc
  window.location = { search: '', hostname: '127.0.0.1' }
  window.innerWidth = window.innerHeight = 1
  window.getComputedStyle = doc.defaultView.getComputedStyle
  globalThis.localStorage = { getItem: () => null }
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch in isolated fixture') }
  const polls = new Map()
  let nextTimer = 0
  globalThis.setInterval = callback => { polls.set(++nextTimer, callback); return nextTimer }
  globalThis.clearInterval = id => polls.delete(id)
  const create = doc.createElement.bind(doc)
  doc.createElement = tag => {
    const node = create(tag)
    if (tag === 'dialog') { node.showModal = () => { node.open = true }; node.close = () => { node.open = false } }
    return node
  }
  outcomes.resetUndeliveredDecisions()
  const original = exampleOwnerPrompts(Date.now())
  let prompts = [...original]
  const purchase = original.find(row => row.kind === 'purchase_batch').id
  const unrelated = original.find(row => row.kind === 'confirmation').id
  let snapshotFailure = false
  let confirmReply = { ok: true, kind: 'P', count: 1 }
  const decisions = new Map()
  const snapshot = () => ({ ok: true, schemaVersion: 1, generatedAt: new Date().toISOString(), theme, prompts: [...prompts] })
  setBridgeTransport(async (pathname, { body }) => {
    if (pathname === '/v1/owner-prompts') return snapshotFailure ? { ok: false, reason: 'Fixture queue unreadable' } : snapshot()
    if (pathname === '/v1/actions/owner-prompt-presented') return { ok: true }
    if (pathname === '/v1/actions/owner-prompt-decision') {
      const pending = deferred()
      decisions.set(body.promptId, pending)
      return pending.promise
    }
    throw new Error('Unexpected bridge path: ' + pathname)
  })
  const mounts = []
  const mountQueue = async () => {
    const queue = ledgerPromptQueue()
    mounts.push(queue)
    doc.body.append(queue.el)
    await settle()
    return queue
  }
  const queue = await mountQueue()
  const resetRoot = doc.createElement('main')
  resetRoot.innerHTML = '<div data-ledger-resets><button data-reset-kind="P">Reset purchases</button></div><p data-ledger-reset-status></p>'
  doc.body.append(resetRoot)
  const confirmed = []
  const challenge = { kind: 'P', count: 1, promptCount: 1, revision: 25, token: 'a'.repeat(64) }
  let refreshes = 0
  const controls = mountLedgerResetControls(resetRoot, {
    bridge: {
      ledgerResetPreview: async () => challenge,
      ledgerResetConfirm: async request => {
        confirmed.push(request)
        if (confirmReply.ok) prompts = prompts.filter(row => row.kind !== 'purchase_batch')
        return confirmReply
      },
    },
    onReset() { refreshes++; queue.destroy(); queue.el.remove() },
  })
  controls.update({ enabled: true })
  t.after(() => {
    controls.destroy()
    for (const mount of mounts) mount.destroy()
    setBridgeTransport(null)
    outcomes.resetUndeliveredDecisions()
    Element.prototype.getBoundingClientRect = rectangle
    if (offset) Object.defineProperty(Element.prototype, 'offsetParent', offset)
    else delete Element.prototype.offsetParent
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.restore()
  })
  return {
    queue, purchase, unrelated, confirmed, mountQueue, snapshot,
    get refreshes() { return refreshes },
    removePurchase() { prompts = prompts.filter(row => row.id !== purchase) },
    addPurchase() {
      const added = { ...original.find(row => row.id === purchase), id: 'later-purchase' }
      prompts.push(added)
      return added.id
    },
    failSnapshot(value = true) { snapshotFailure = value },
    resetReply(reply) { confirmReply = reply },
    async submit(id, mount = queue) {
      const card = mount.el.querySelector('[data-prompt-id="' + id + '"]')
      const button = card?.querySelector('.owner-popup-primary')
      assert.ok(button, 'real queue rendered the submitted card')
      assert.equal(button.disabled, false, 'real presentation handshake enabled the card')
      button.click(); await settle()
      assert.ok(decisions.has(id), 'real submit reached the deferred transport')
    },
    async answer(id, reply = { ok: false, reason: 'Fixture refused decision' }) {
      decisions.get(id).resolve(reply); await settle()
    },
    async reset() {
      resetRoot.querySelector('[data-reset-kind]').click(); await settle()
      doc.body.querySelector('[data-reset-confirm]').click(); await settle()
    },
    async poll() { for (const callback of [...polls.values()]) callback(); await settle() },
  }
}

test('a delayed purchase refusal cannot resurrect an outcome after reset and cross-view reconciliation', async t => {
  const f = await fixture(t)
  await f.submit(f.purchase)
  await f.submit(f.unrelated)
  await f.reset()
  assert.equal(f.refreshes, 1)
  assert.deepEqual(f.confirmed, [{ kind: 'P', revision: 25, token: 'a'.repeat(64) }])
  // The next view reads the complete queue, just as Home does.
  outcomes.reconcileUndeliveredDecisions(f.snapshot().prompts.map(row => row.id))
  await f.answer(f.unrelated)
  assert.ok(outcomes.undeliveredDecision(f.unrelated), 'unrelated still-pending failure survives the destroyed view')
  const announcements = []
  const listen = event => announcements.push(event.detail.count)
  const outcomeWindow = window
  outcomeWindow.addEventListener(outcomes.APPROVAL_OUTCOME_EVENT, listen)
  t.after(() => outcomeWindow.removeEventListener(outcomes.APPROVAL_OUTCOME_EVENT, listen))
  await f.answer(f.purchase)
  assert.deepEqual(announcements, [], 'the reset failure must not announce itself to Home')
  assert.equal(outcomes.undeliveredDecision(f.purchase), null, 'reset purchase failure was resurrected by its delayed response')
  assert.equal(outcomes.undeliveredDecisionCount(), 1, 'Home must receive only the unrelated genuine failure')
})

test('a still-pending purchase refusal survives navigation and a fresh queue read', async t => {
  const f = await fixture(t)
  await f.submit(f.purchase)
  f.queue.destroy()
  outcomes.reconcileUndeliveredDecisions([f.purchase, f.unrelated])
  await f.answer(f.purchase)
  assert.ok(outcomes.undeliveredDecision(f.purchase))
  const next = await f.mountQueue()
  assert.match(next.el.textContent, /decision you submitted was not recorded/)
  assert.equal(outcomes.undeliveredDecisionCount(), 1)
})

test('unreadable queue replies do not retire genuine in-flight or earlier failures', async t => {
  const f = await fixture(t)
  outcomes.recordUndeliveredDecision(f.unrelated, 'Earlier unrelated failure')
  await f.submit(f.purchase)
  f.failSnapshot()
  await f.poll()
  f.queue.destroy()
  await f.answer(f.purchase)
  assert.equal(outcomes.undeliveredDecisionCount(), 2)
  assert.ok(outcomes.undeliveredDecision(f.unrelated))
  assert.ok(outcomes.undeliveredDecision(f.purchase))
})

test('a successful reset with an unreadable follow-up queue prunes nothing until a readable observation', async t => {
  const f = await fixture(t)
  outcomes.recordUndeliveredDecision(f.unrelated, 'Earlier unrelated failure')
  await f.submit(f.purchase)
  f.failSnapshot()
  await f.reset()
  assert.equal(f.refreshes, 1)
  await f.answer(f.purchase)
  assert.equal(outcomes.undeliveredDecisionCount(), 2, 'unknown queue is not evidence of absence')
  outcomes.reconcileUndeliveredDecisions([f.unrelated])
  assert.equal(outcomes.undeliveredDecision(f.purchase), null)
  assert.ok(outcomes.undeliveredDecision(f.unrelated))
})

for (const reply of [
  { ok: false, code: 'R_LEDGER_RESET_STALE', reason: 'Review the current count.' },
  { ok: false, pending: true, reason: 'Finish the same reset.' },
  { ok: false, pending: false, aborted: true, reason: 'Review the current count.' },
]) test('a reset refusal does not retire a delayed decision: ' + (reply.code || (reply.pending ? 'pending' : 'aborted')), async t => {
  const f = await fixture(t)
  await f.submit(f.purchase)
  f.resetReply(reply)
  await f.reset()
  assert.equal(f.refreshes, 0)
  assert.deepEqual(f.confirmed, [{ kind: 'P', revision: 25, token: 'a'.repeat(64) }])
  f.queue.destroy()
  await f.answer(f.purchase)
  assert.ok(outcomes.undeliveredDecision(f.purchase), 'no successful reset observation retired this prompt')
})

test('an older observation cannot revive a decision already retired by the reset', async t => {
  const f = await fixture(t)
  await f.submit(f.purchase)
  await f.reset()
  outcomes.reconcileUndeliveredDecisions([f.purchase, f.unrelated])
  await f.answer(f.purchase)
  assert.equal(outcomes.undeliveredDecisionCount(), 0)
})

test('a normal queue removal also fences the reply while the submitting view stays mounted', async t => {
  const f = await fixture(t)
  await f.submit(f.purchase)
  f.removePurchase()
  await f.poll()
  await f.answer(f.purchase)
  assert.equal(outcomes.undeliveredDecisionCount(), 0)
  assert.equal(f.queue.el.querySelector('[data-prompt-id="' + f.purchase + '"]') === null, true)
})

test('a purchase added after reset has an independent outcome that still crosses views', async t => {
  const f = await fixture(t)
  await f.submit(f.purchase)
  await f.reset()
  const laterId = f.addPurchase()
  const next = await f.mountQueue()
  await f.submit(laterId, next)
  next.destroy()
  await f.answer(f.purchase)
  await f.answer(laterId)
  assert.equal(outcomes.undeliveredDecision(f.purchase), null)
  assert.ok(outcomes.undeliveredDecision(laterId))
  assert.equal(outcomes.undeliveredDecisionCount(), 1)
})

test('a delayed success clears its earlier failure after navigation', async t => {
  const f = await fixture(t)
  outcomes.recordUndeliveredDecision(f.purchase, 'Earlier refused attempt')
  outcomes.recordUndeliveredDecision(f.unrelated, 'Keep this unrelated failure')
  await f.submit(f.purchase)
  f.queue.destroy()
  await f.answer(f.purchase, { ok: true })
  assert.equal(outcomes.undeliveredDecision(f.purchase), null)
  assert.ok(outcomes.undeliveredDecision(f.unrelated))
})
