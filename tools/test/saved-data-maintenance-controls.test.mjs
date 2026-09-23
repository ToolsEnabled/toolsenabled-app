import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createSavedDataMaintenanceSettings } from '../../src/saved-data-maintenance-controls.js'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve)) }
function fixture(t, overrides = {}) {
  const dom = installDomStandIn(), calls = []
  let allowed = true, externalBusy = false
  const bridge = {
    nodeStatusRepairPreview: async value => { calls.push(['repairPreview', value]); return { ok: true, previewToken: 'repair-token' } },
    nodeStatusRepairConfirm: async value => { calls.push(['repairConfirm', value]); return { ok: true, confirmed: true, changedKeys: [] } },
    nodeStatusRollbackPreview: async value => { calls.push(['rollbackPreview', value]); return { ok: true, previewToken: 'rollback-token' } },
    nodeStatusRollbackConfirm: async value => { calls.push(['rollbackConfirm', value]); return { ok: true, confirmed: true, changedKeys: [] } },
    continuationPrunePreview: async () => { calls.push(['prunePreview']); return { ok: true, eligible: 2, selected: 2, limit: 10, scopeHash: 'scope' } },
    continuationPruneConfirm: async value => { calls.push(['pruneConfirm', value]); return value.stage === 'prepare'
      ? { ok: true, token: 'prune-token' } : { ok: false, code: 'CONTINUATION_PRUNE_CANCELLED', reason: 'The owner did not confirm. Nothing was removed.' } },
    ...overrides,
  }
  const controller = createSavedDataMaintenanceSettings({ bridge,
    mayRun: () => allowed, isBlocked: () => externalBusy, onBusy: value => { externalBusy = value },
    durable: { refreshFleet: keys => { calls.push(['refresh', keys]); return { ok: true, changes: [] } } } })
  const root = document.createElement('main'); root.innerHTML = controller.markup(); document.body.appendChild(root)
  controller.bind(root)
  t.after(() => { controller.destroy(); dom.restore() })
  const button = action => root.querySelector(`[data-saved-maintenance-action="${action}"]`)
  return { controller, root, calls, bridge, button, status: () => root.querySelector('[data-saved-maintenance-status]').textContent,
    disable() { allowed = false; controller.afterRender() } }
}

test('maintenance panel mounts without reading or changing saved data and reaches native repair only on a press', async t => {
  const f = fixture(t)
  assert.deepEqual(f.calls, [])
  assert.equal(f.button('repair').disabled, false)
  f.button('repair').click(); await settle()
  assert.deepEqual(f.calls, [['repairPreview', {}], ['repairConfirm', { previewToken: 'repair-token' }], ['refresh', []]])
  assert.match(f.status(), /statuses were restored/)
})

test('orphan cleanup prepares a backup then respects native cancellation without claiming removal', async t => {
  const f = fixture(t)
  f.button('prune').click(); await settle()
  assert.deepEqual(f.calls, [['prunePreview'], ['pruneConfirm', { stage: 'prepare', scopeHash: 'scope', limit: 10 }], ['pruneConfirm', { stage: 'confirm', token: 'prune-token' }]])
  assert.match(f.status(), /did not confirm.*Nothing was removed/)
})

test('a disabled context after preview cannot open a later maintenance confirmation', async t => {
  const gate = deferred(), f = fixture(t, { nodeStatusRepairPreview: () => gate.promise })
  f.button('repair').click(); f.disable()
  gate.resolve({ ok: true, previewToken: 'stale-token' }); await settle()
  assert.deepEqual(f.calls, [])
  assert.equal(f.button('repair').disabled, true)
  assert.match(f.status(), /context changed.*No further maintenance/)
})

test('double pressing maintenance submits one preview and one confirmation', async t => {
  const gate = deferred(), f = fixture(t)
  f.bridge.nodeStatusRepairPreview = async value => { f.calls.push(['repairPreview', value]); return gate.promise }
  f.button('repair').click()
  // A second click already queued by the browser can reach the delegated
  // listener after the first press disabled the element.
  f.root.dispatchEvent({ type: 'click', target: f.button('repair') })
  gate.resolve({ ok: true, previewToken: 'one-token' }); await settle()
  assert.equal(f.calls.filter(row => row[0] === 'repairPreview').length, 1)
  assert.equal(f.calls.filter(row => row[0] === 'repairConfirm').length, 1)
})

test('a confirmed native repair refreshes retained stores even if its Settings page has closed', async t => {
  const gate = deferred(), entered = deferred(), f = fixture(t)
  f.bridge.nodeStatusRepairConfirm = value => { f.calls.push(['repairConfirm', value]); entered.resolve(); return gate.promise }
  f.button('repair').click(); await entered.promise
  f.controller.destroy()
  gate.resolve({ ok: true, confirmed: true, changedKeys: [] }); await settle()
  assert.equal(f.calls.filter(row => row[0] === 'refresh').length, 1)
})

test('an unconfirmed saved-status reply cannot refresh or claim a successful repair', async t => {
  const f = fixture(t, { nodeStatusRepairConfirm: async () => ({ ok: true, changedKeys: [] }) })
  f.button('repair').click(); await settle()
  assert.equal(f.calls.filter(row => row[0] === 'refresh').length, 0)
  assert.match(f.status(), /did not confirm/)
})

test('status rollback uses its own native review and refreshes only its confirmed result', async t => {
  const f = fixture(t, { nodeStatusRollbackConfirm: async value => { f.calls.push(['rollbackConfirm', value]); return { ok: true, confirmed: true, changedKeys: [], audit: { required: true, recorded: false } } } })
  f.button('rollback').click(); await settle()
  assert.deepEqual(f.calls, [['rollbackPreview', {}], ['rollbackConfirm', { previewToken: 'rollback-token' }], ['refresh', []]])
  assert.match(f.status(), /rolled back/)
  assert.match(f.status(), /change completed.*audit outcome could not be recorded/)
})
