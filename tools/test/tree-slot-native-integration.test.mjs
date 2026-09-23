import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createFleetTreeStore, safeTreeStorage, parseFleetTrees, fleetTreesStorageKey, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import * as policy from '../../shell/tree-slot-policy.mjs'
const require = createRequire(import.meta.url)
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')
const { createTreeSlotAdmission } = require('../../shell/tree-slot-admission.cjs')
const { CONFIGURATION_ACTIONS, createTreeSlotConfigurationAuthority } = require('../../shell/tree-slot-configuration.cjs')
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const renderer = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const durable = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const section = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, 'real production entry point must be available')
  return source.slice(a, b)
}
const key = fleetTreesStorageKey('fixture')
function initial(count = 0) {
  let text = null, serial = 0
  const store = createFleetTreeStore({ computerId: 'fixture', makeId: kind => kind + '-' + (++serial),
    readBounds: () => ({ maxChildren: 64, maxDepth: 16 }),
    storage: { read: () => text, write: (_key, record) => { text = JSON.stringify(record); return true } } })
  const root = store.addNode({ role: 'controller', message: 'Root fixture' }).node
  store.attachSession(root.id, 'parent-session')
  for (let i = 0; i < count; i++) assert.equal(store.addNode({ parentId: root.id, role: 'worker', message: 'Saved fixture' }).ok, true)
  return { text, root }
}
function fixture(t, count = 0) {
  const seed = initial(count), state = { bounds: { maxChildren: 4, maxDepth: 3 }, replies: [] }
  let authority
  // Only synchronous in-memory preference adoption is exercised. No filesystem
  // write is available; sealing cancels its deferred flush before this test ends.
  const memoryFs = { readFileSync() { throw Object.assign(new Error('synthetic absence'), { code: 'ENOENT' }) } }
  const prefs = createRendererPrefs({ directory: path.join(process.env.TMPDIR, 'memory-only-prefs'), fs: memoryFs, path, randomUUID,
    validateTreeChange: request => authority ? authority.validateWrite(request) : { ok: true } })
  assert.equal(prefs.set(key, seed.text).ok, true)
  t.after(() => prefs.sealForErase())
  authority = createTreeSlotAdmission({ readBounds: () => ({ ok: true, bounds: state.bounds }),
    readForest: () => parseFleetTrees(prefs.snapshot().values[key], { computerId: 'fixture' }), parseRecord: parseFleetTrees,
    policy, makeId: () => 'node-' + randomUUID() })
  let handler
  vm.runInNewContext(section(main, "ipcMain.on('mc-prefs:write'", '/* THE ONE READ THAT DOES NOT COME'), {
    ipcMain: { on(_name, callback) { handler = callback } }, trustedFleetProfileSender: () => true,
    localDataErased: false, WEB_DRIVE_PREF_KEY: 'unused', rendererPrefs: prefs,
    notePrefsRefusal: (_verb, _key, result) => result, mirrorUninstallRetentionIfRelevant() {},
  })
  function page() {
    const window = { localStorage: {}, mcPrefs: { available: true, values: { ...prefs.snapshot().values },
      write(key, value, expectedValue) {
        const event = {}
        handler(event, { key, value, ...(expectedValue !== undefined ? { expectedValue } : {}) })
        state.replies.push(event.returnValue)
        return event.returnValue
      },
    } }
    vm.runInNewContext(durable, { window })
    return createFleetTreeStore({ computerId: 'fixture', storage: safeTreeStorage(window.localStorage),
      readBounds: () => ({ maxChildren: 4, maxDepth: 3 }), makeId: kind => kind + '-' + randomUUID() })
  }
  return { ...seed, state, prefs, authority, handler, page }
}
test('actual native save refusal does not publish a new unsaved slot', t => {
  const f = fixture(t, 1), page = f.page(), before = page.snapshot().nodes
  f.state.bounds = { maxChildren: 1, maxDepth: 3 }
  const result = page.addNode({ parentId: f.root.id, role: 'worker', message: 'No room now' })
  assert.equal(result.ok, false)
  assert.deepEqual(page.snapshot().nodes, before)
  assert.equal(parseFleetTrees(f.prefs.snapshot().values[key]).nodes.length, 2)
  assert.equal(f.state.replies.at(-1).error.code, 'TREE_SLOT_LIMIT')
})
test('two actual durable pages cannot overwrite each other through a stale forest save', t => {
  const f = fixture(t), first = f.page(), stale = f.page(), before = stale.snapshot().nodes
  const accepted = first.addNode({ parentId: f.root.id, role: 'worker', message: 'Keep this child' })
  assert.equal(accepted.ok, true)
  const refused = stale.addNode({ parentId: f.root.id, role: 'worker', message: 'Stale extra child' })
  assert.equal(refused.ok, false)
  assert.deepEqual(stale.snapshot().nodes, before)
  const saved = parseFleetTrees(f.prefs.snapshot().values[key])
  assert.deepEqual(saved.nodes.map(node => node.id), [f.root.id, accepted.node.id])
  assert.equal(f.state.replies.at(-1).error.code, 'MC_TREE_STORAGE_CHANGED')
})
test('native prefs IPC refuses a forest save with no prior record token', t => {
  const f = fixture(t), event = {}
  f.handler(event, { key, value: f.text })
  assert.equal(event.returnValue.ok, false)
  assert.equal(event.returnValue.error.code, 'MC_TREE_STORAGE_REVISION_REQUIRED')
  assert.equal(f.prefs.snapshot().values[key], f.text)
})
function dispatchFixture(t) {
  const f = fixture(t, 3), commands = new Map(), state = { timeout: null }
  const context = {
    treeCommandComputerId: 'fixture', randomUUID, treeSlotAdmission: f.authority, CONFIGURATION_ACTIONS,
    treeSlotConfiguration: createTreeSlotConfigurationAuthority({
      readParent: id => id === 'parent-session' ? { nodeId: f.root.id, treeId: f.root.treeId, owner: 'owner', permissionSession: { origin: 'local', tier: 'full' } } : null,
      readForest: () => parseFleetTrees(f.prefs.snapshot().values[key]), readSessionOwner: () => 'owner',
    }),
    treeSpawnError: (code, message) => Object.assign(new Error(message), { code }),
    readTreeParentAuthority: () => null, TREE_SPAWN_DELIVERY_MS: 2000,
    treeNodeCommandBroker: { state: () => ({ queued: commands.size }) }, localTreeCommands: commands,
    setTimeout: callback => { state.timeout = callback; return 1 }, clearTimeout() {},
    queueTreeNodeCommand: () => true,
  }
  const dispatch = vm.runInNewContext(section(main, 'function dispatchTreeSpawn(', 'let treeNodeCommandDispatchEnabled') + ';dispatchTreeSpawn', context)
  const clean = new Function('FLEET_TREE_LIMITS', section(renderer, 'function cleanTreeNodeCommand(value)', 'async function completeTreeNodeCommand') + ';return cleanTreeNodeCommand')(FLEET_TREE_LIMITS)
  return { ...f, commands, dispatch, clean, state }
}
test('actual dispatch reserves the last slot and carries its identity through the renderer gate', async t => {
  const f = dispatchFixture(t), request = { parentSessionId: 'parent-session', role: 'worker', tier: 'codex', brief: 'Synthetic task' }
  const first = f.dispatch(request)
  const entry = [...f.commands.values()][0], command = entry.envelope.request
  assert.equal(typeof command.reservedNodeId, 'string')
  assert.equal(f.clean(command)?.reservedNodeId, command.reservedNodeId)
  await assert.rejects(f.dispatch(request), error => error.code === 'TREE_SLOT_LIMIT')
  entry.resolve({ ok: true })
  await first
  const next = f.dispatch(request)
  assert.notEqual([...f.commands.values()][0].envelope.request.reservedNodeId, command.reservedNodeId)
  ;[...f.commands.values()][0].resolve({ ok: true })
  await next
})
test('actual delivery timeout releases only an unfilled reservation for retry', async t => {
  const f = dispatchFixture(t), request = { parentSessionId: 'parent-session', role: 'worker', tier: 'codex', brief: 'Synthetic task' }
  const first = f.dispatch(request)
  f.state.timeout()
  await assert.rejects(first, error => error.code === 'MC_TREE_SPAWN_NOT_DELIVERED')
  const next = f.dispatch(request)
  ;[...f.commands.values()][0].resolve({ ok: true })
  await next
  assert.equal(f.commands.size, 0)
})

test('actual configuration dispatch binds the managed slot without allocating a sibling', async t => {
  const f = dispatchFixture(t)
  const child = parseFleetTrees(f.prefs.snapshot().values[key]).nodes.find(node => node.parentId === f.root.id)
  for (const action of CONFIGURATION_ACTIONS) {
    const promise = f.dispatch({ action, parentSessionId: 'parent-session', nodeId: child.id, choice: 'synthetic-choice' })
    const entry = [...f.commands.values()][0], clean = f.clean(entry.envelope.request)
    assert.equal(clean.nodeId, child.id)
    assert.equal(clean.choice, 'synthetic-choice')
    assert.equal(clean.expectedSessionId, null)
    assert.equal(clean.reservedNodeId, undefined)
    entry.resolve({ ok: true, state: 'pending', nodeId: child.id })
    await promise
  }
  await assert.rejects(f.dispatch({ action: 'set-node-role', parentSessionId: 'parent-session', nodeId: f.root.id, choice: 'worker' }),
    error => error.code === 'TREE_CONFIGURATION_REFUSED')
  assert.equal(parseFleetTrees(f.prefs.snapshot().values[key]).nodes.length, 4)
})
