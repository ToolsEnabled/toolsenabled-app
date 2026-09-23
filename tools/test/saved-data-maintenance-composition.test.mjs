import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createFleetTreeStore, safeTreeStorage, fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { createSavedDataMaintenanceSettings } from '../../src/saved-data-maintenance-controls.js'
const require = createRequire(import.meta.url)
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')
const { registerSavedDataMaintenanceIpc } = require('../../shell/saved-data-maintenance-ipc.cjs')
const { createSavedDataMaintenanceAdapter } = require('../../shell/saved-data-maintenance.cjs')
const durableSource = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const preloadSource = fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
const wrapper = values => JSON.stringify({ storageVersion: 1, values }) + '\n'
const settle = async predicate => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('native maintenance did not settle within the bounded fixture wait')
}
function fixture(t) {
  const dom = installDomStandIn()
  const root = fs.mkdtempSync(path.join(process.env.IMAGE_TEST_TEMP || os.tmpdir(), 'retained-maintenance-composition-'))
  t.diagnostic('RETAINED_FIXTURE ' + root)
  const computerId = 'synthetic-maintenance-' + randomUUID(), key = fleetTreesStorageKey(computerId)
  const seedComputerId = computerId + '-seed', seedKey = fleetTreesStorageKey(seedComputerId)
  const seed = new Map(), seedStorage = safeTreeStorage({ getItem: name => seed.get(name) ?? null,
    setItem: (name, text) => seed.set(name, text) })
  const seeded = createFleetTreeStore({ computerId: seedComputerId, storage: seedStorage, makeId: kind => kind + '-' + randomUUID() })
  const node = seeded.addNode({ role: 'controller', message: 'Synthetic retained task' }).node
  seeded.attachSession(node.id, 'synthetic-session'); seeded.setNodeStatus(node.id, 'turn-failed', { turnId: 'synthetic-turn', note: 'Synthetic stale failure' })
  const seedTree = JSON.parse(seed.get(seedKey)); seedTree.computerId = computerId
  const beforeTree = JSON.stringify(seedTree), snapshotTree = JSON.parse(beforeTree)
  snapshotTree.nodes[0].status = 'finished'; delete snapshotTree.nodes[0].statusNote
  const before = wrapper({ [key]: beforeTree })
  const fleetFile = path.join(root, 'renderer-fleet-documents.json'), snapshotPath = path.join(root, 'chosen-snapshot.json')
  fs.writeFileSync(fleetFile, before, { flag: 'wx' })
  fs.writeFileSync(path.join(root, 'renderer-prefs.json'), JSON.stringify({ storageVersion: 1, values: {}, drainedOrigins: [] }), { flag: 'wx' })
  fs.writeFileSync(snapshotPath, wrapper({ [key]: JSON.stringify(snapshotTree) }), { flag: 'wx' })
  const prefs = createRendererPrefs({ directory: root, fs, path, randomUUID })
  const exposed = {}, handlers = new Map(), replies = [], dialogs = []
  const owner = { isDestroyed: () => false }, principal = { kind: 'window', mayWrite: true, owner }
  let chosen = snapshotPath, approve = true
  const dialog = {
    async showOpenDialog() { return { canceled: false, filePaths: [chosen] } },
    async showMessageBox(_parent, request) { dialogs.push(request); return { response: approve ? 1 : 0 } },
  }
  const adapter = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => null, requireModule: require,
    dialog, rendererPrefs: prefs, fleetStorePath: fleetFile, browserWindowForPrincipal: () => null,
    chooseSnapshotFile: async () => chosen, chooseRollbackFile: async () => chosen })
  registerSavedDataMaintenanceIpc({ capturePolicy: () => ({ ok: true, decision: { required: false } }), ipcMain: { handle(channel, listener) { handlers.set(channel, listener) } },
    getAdapter: () => adapter, principalFor: () => principal, assertTrustedSender: event => assert.equal(event.sender, owner) })
  vm.runInNewContext(preloadSource, { process: { platform: process.platform }, window: { addEventListener() {} },
    require: () => ({ contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value } },
      ipcRenderer: { on() {}, send() {}, removeListener() {}, sendSync: () => ({}),
        invoke: async (channel, value) => { const result = await handlers.get(channel)({ sender: owner }, value); replies.push({ channel, result }); return result } } }) })
  window.mcPrefs = { available: true, ...prefs.snapshot(), read: name => ({ ok: true, value: prefs.snapshot().values[name] ?? null }),
    write: (name, value, expectedValue) => prefs.set(name, value, { expectedValue }) }
  window.localStorage = {}
  vm.runInNewContext(durableSource, { window })
  const store = createFleetTreeStore({ computerId, storage: safeTreeStorage(window.localStorage) })
  let busy = false
  const controller = createSavedDataMaintenanceSettings({ bridge: exposed.mcAgent, durable: window.mcDurableStorage,
    onBusy: value => { busy = value } })
  const panel = document.createElement('main'); panel.innerHTML = controller.markup(); document.body.appendChild(panel); controller.bind(panel)
  t.after(() => { controller.destroy(); prefs.sealForErase(); dom.restore() })
  async function press(action) {
    const start = replies.length
    panel.querySelector(`[data-saved-maintenance-action="${action}"]`).click()
    await settle(() => !busy && replies.length > start)
    return replies.at(-1).result
  }
  return { root, key, node, before, fleetFile, snapshotPath, prefs, store, press, dialogs, replies,
    status: () => panel.querySelector('[data-saved-maintenance-status]').textContent,
    choose(file) { chosen = file }, cancel() { approve = false } }
}

test('mounted maintenance reaches real native snapshot repair and rollback and refreshes the saved and open tree', async t => {
  const f = fixture(t)
  const repaired = await f.press('repair')
  assert.equal(repaired.ok, true, JSON.stringify(repaired))
  assert.equal(repaired.confirmed, true)
  assert.equal(repaired.postWriteVerified, true)
  assert.deepEqual(repaired.changedKeys, [f.key])
  assert.equal(fs.readFileSync(repaired.backupPath, 'utf8'), f.before)
  assert.equal(f.store.getNode(f.node.id).status, 'finished')
  assert.equal(JSON.parse(f.prefs.snapshot().values[f.key]).nodes[0].status, 'finished')
  assert.match(f.status(), /Open trees now use/)
  f.choose(repaired.backupPath)
  const rolledBack = await f.press('rollback')
  assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack))
  assert.equal(fs.readFileSync(f.fleetFile, 'utf8'), f.before)
  assert.equal(f.store.getNode(f.node.id).status, 'turn-failed')
  assert.equal(f.store.getNode(f.node.id).message, 'Synthetic retained task')
  assert.equal(f.dialogs.length, 2)
})

test('mounted maintenance native cancellation retains bytes and cannot paint a successful repair', async t => {
  const f = fixture(t); f.cancel()
  const result = await f.press('repair')
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(f.fleetFile, 'utf8'), f.before)
  assert.equal(f.store.getNode(f.node.id).status, 'turn-failed')
  assert.doesNotMatch(f.status(), /statuses were restored/)
  assert.match(f.status(), /not approve|not confirm|cancel/i)
})
