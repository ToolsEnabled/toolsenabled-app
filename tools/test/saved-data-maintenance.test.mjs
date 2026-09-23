// Behaviour of shell/saved-data-maintenance.cjs, the native adapter behind the saved-data maintenance routes.
//
// Memory only. The filesystem is a Map behind an injected fs, the renderer-prefs cache is the REAL createRendererPrefs()
// over that Map (so the {storageVersion,values} wrapper, fleetPending, fleetWriteError, fleetDamaged and the
// commitFleetMaintenance seam are the real module's own), and the prune engine, repair service and native dialogs are
// fakes that record what they were asked. Nothing is written to or removed from a real disk. The one exception to fakes
// is the real repair service's prepareRepair, driven over the same Map to prove the adapter meets its literal API.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createSavedDataMaintenanceAdapter, readFleetStore, readTreeSnapshot, statusOnlyDiff, isPerson, createNativeConfirmOwner, createNativeRepairConfirmOwner,
  createNativeRollbackConfirmOwner, CODES, REASONS,
} = require('../../shell/saved-data-maintenance.cjs')
const { createRendererPrefs, MAX_FLEET_RECORD_BYTES, RECORD_FILE, RENDERER_FLEET_FILE } = require('../../shell/renderer-prefs.cjs')
const realRepairService = require('../../shell/saved-node-status-repair.cjs')

const TREE_KEY = 'mc.fleet.trees.v1:this-computer'
const DIFF_KEY = 'mc.fleet.chat-diffs.v1:synthetic-node'
// The person at the keyboard: the app window, allowed to write, whose window is there.
const livePerson = () => Object.freeze({ kind: 'window', mayWrite: true, owner: { destroyed: false, isDestroyed() { return this.destroyed } } })
const person = livePerson()
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const treeDocument = (computer, nodes) => JSON.stringify({
  version: 1, computerId: computer, trees: [{ id: `tree-${computer}` }],
  nodes: nodes.map(([id, status = 'running', extra = {}]) => ({ id, treeId: `tree-${computer}`, status, ...extra })),
})
const wrapperOf = values => `${JSON.stringify({ storageVersion: 1, values })}\n`
// node-a1 is the repair candidate throughout this file: it starts turn-failed, the guarded service's own repair
// scope (finished<->turn-failed only), not the default 'running' -- a repair that finishes it is then a change the
// guard accepts, not one it has to refuse for being outside scope.
const baseValues = () => ({ [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'turn-failed'], ['node-a2', 'finished']]), [DIFF_KEY]: 'unrelated chat diff bytes' })

// ---- fixtures: the real cache over an in-memory filesystem ----

function memoryFs(initial) {
  const files = new Map(Object.entries(initial))
  const handles = new Map()
  const fail = { read: null, open: null }
  let serial = 0
  const error = code => Object.assign(new Error(`synthetic ${code}`), { code })
  const fs = {
    readFileSync(file) {
      if (fail.read && String(file).endsWith(RENDERER_FLEET_FILE)) throw error(fail.read)
      if (!files.has(file)) throw error('ENOENT')
      return files.get(file)
    },
    readdirSync() { return [] },
    mkdirSync() {},
    openSync(file) { if (fail.open) throw error(fail.open); if (files.has(file)) throw error('EEXIST'); const fd = ++serial; handles.set(fd, file); files.set(file, ''); return fd },
    writeFileSync(fd, text) { files.set(handles.get(fd), text) },
    fsyncSync() {},
    closeSync(fd) { handles.delete(fd) },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync() { throw error('EPERM') },
  }
  return { fs, files, fail }
}

function fixture(t, { values = baseValues(), fleetText, recordText } = {}) {
  const directory = path.resolve('synthetic-saved-data-maintenance')
  const fleetFile = path.join(directory, RENDERER_FLEET_FILE)
  const initial = { [path.join(directory, RECORD_FILE)]: recordText ?? JSON.stringify({ storageVersion: 1, values: {}, drainedOrigins: [] }) }
  if (fleetText !== null) initial[fleetFile] = fleetText ?? wrapperOf(values)
  const memory = memoryFs(initial)
  let serial = 0
  const prefs = createRendererPrefs({ directory, fs: memory.fs, path, randomUUID: () => `synthetic-${++serial}` })
  prefs.snapshot()
  t.after(() => prefs.sealForErase())
  return { prefs, fleetFile, directory, values, ...memory, disk: () => memory.files.get(fleetFile) }
}

const deps = f => ({ rendererPrefs: f.prefs, storePath: f.fleetFile, fs: f.fs })
const stored = f => readFleetStore(deps(f))
const snapshotOf = f => readTreeSnapshot(deps(f))
// A renderer save followed by the debounce elapsing: cache and disk move together, as they do in the app.
async function save(f, key, value) {
  assert.equal(f.prefs.set(key, value, { expectedValue: f.prefs.snapshot().values[key] }).ok, true)
  assert.equal((await f.prefs.flushFleetDocuments()).ok, true)
}
const healthy = (values, extra = {}) => ({ ok: true, values, drainedOrigins: [], damaged: null, fleetDamaged: null, fleetPending: false, fleetWriteError: null, preservedAt: null, ...extra })
const fakePrefs = (snapshot, commit = () => ({ ok: true })) => ({ snapshot: typeof snapshot === 'function' ? snapshot : () => snapshot, commitFleetMaintenance: commit })
const FAKE_STORE = path.resolve('synthetic-fake-store', RENDERER_FLEET_FILE)
// A store the fakes agree on: what the cache holds is what the file holds.
const agreeing = (values, file = wrapperOf(values)) => ({ rendererPrefs: fakePrefs(healthy(values)), storePath: FAKE_STORE, fs: { readFileSync: () => file } })

// ---- the gate: cache and durable file ----

test('a settled store whose cache and durable file agree is read complete, and hashed as its exact durable bytes', t => {
  const f = fixture(t)
  const store = stored(f)
  assert.equal(store.ok, true)
  assert.equal(store.sha256, sha(f.disk()))
  assert.equal(store.bytes, Buffer.byteLength(f.disk()))
  const snapshot = snapshotOf(f)
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.persistenceFailed, false)
  assert.equal(snapshot.revision, store.sha256)
  assert.deepEqual(snapshot.trees.map(tree => tree.id), ['tree-this-computer'])
  assert.deepEqual(snapshot.nodes.map(node => [node.id, node.treeId]), [['node-a1', 'tree-this-computer'], ['node-a2', 'tree-this-computer']])
})

test('the hash covers the complete wrapper: a chat-diff document, or only the file layout, moves it', t => {
  const plain = fixture(t)
  const otherDiff = fixture(t, { values: { ...baseValues(), [DIFF_KEY]: 'different chat diff bytes' } })
  const spaced = fixture(t, { fleetText: `${JSON.stringify({ storageVersion: 1, values: baseValues() }, null, 1)}\n` })
  for (const f of [plain, otherDiff, spaced]) assert.equal(stored(f).sha256, sha(f.disk()))
  assert.equal(new Set([plain, otherDiff, spaced].map(f => stored(f).sha256)).size, 3)
  // The same trees in all of them: the ids the engine works from do not move, the revision does.
  assert.deepEqual(snapshotOf(otherDiff).nodes, snapshotOf(plain).nodes)
  assert.deepEqual(snapshotOf(spaced).nodes, snapshotOf(plain).nodes)
  assert.notEqual(snapshotOf(otherDiff).revision, snapshotOf(plain).revision)
})

test('the cache and the durable file must agree exactly: every way they can differ is refused', t => {
  const divergences = {
    'a durable value changed after the cache loaded': f => f.files.set(f.fleetFile, wrapperOf({ ...f.values, [DIFF_KEY]: 'written by someone else' })),
    'the durable file gained a document the cache does not hold': f => f.files.set(f.fleetFile, wrapperOf({ ...f.values, 'mc.fleet.chat-diffs.v1:another-node': 'x' })),
    'the durable file lost a document the cache holds': f => f.files.set(f.fleetFile, wrapperOf({ [TREE_KEY]: f.values[TREE_KEY] })),
    'the durable file is gone while the cache holds trees': f => f.files.delete(f.fleetFile),
  }
  for (const [name, diverge] of Object.entries(divergences)) {
    const f = fixture(t)
    diverge(f)
    const store = stored(f)
    assert.equal(store.ok, false, name)
    assert.equal(store.code, CODES.DISAGREES, name)
    assert.equal(store.persistenceFailed, true, name)
    const snapshot = snapshotOf(f)
    assert.equal(snapshot.complete, false, name)
    assert.equal(snapshot.persistenceFailed, true, name)
    assert.equal(snapshot.reason, CODES.DISAGREES, name)
    assert.deepEqual([snapshot.trees, snapshot.nodes], [[], []], name)
  }
})

test('a durable wrapper the cache would not have kept is refused as damaged', t => {
  const wrappers = {
    'an entry that is not a fleet document key': wrapperOf({ ...baseValues(), 'mc.settings.theme': 'dark' }),
    'an entry whose value is not a string': `${JSON.stringify({ storageVersion: 1, values: { ...baseValues(), [DIFF_KEY]: 5 } })}\n`,
    'another storage version': `${JSON.stringify({ storageVersion: 2, values: baseValues() })}\n`,
    'values that are not an object': `${JSON.stringify({ storageVersion: 1, values: [] })}\n`,
    'text that is not JSON': 'not json{',
    'nothing at all': '',
  }
  for (const [name, text] of Object.entries(wrappers)) {
    const f = fixture(t)
    f.files.set(f.fleetFile, text)
    const store = stored(f)
    assert.equal(store.code, CODES.FLEET_DAMAGED, name)
    assert.equal(store.persistenceFailed, true, name)
  }
})

test('a store with unsaved changes is refused as not settled, not as damaged, and reads again once written', async t => {
  const f = fixture(t)
  const edited = treeDocument('this-computer', [['node-a1'], ['node-a2', 'finished'], ['node-a3']])
  assert.equal(f.prefs.set(TREE_KEY, edited, { expectedValue: f.values[TREE_KEY] }).ok, true)
  assert.equal(f.prefs.snapshot().fleetPending, true)
  const store = stored(f)
  assert.equal(store.code, CODES.PENDING)
  assert.equal(store.persistenceFailed, false)
  assert.equal(snapshotOf(f).persistenceFailed, false)
  assert.equal((await f.prefs.flushFleetDocuments()).ok, true)
  assert.equal(stored(f).ok, true)
  assert.deepEqual(snapshotOf(f).nodes.map(node => node.id), ['node-a1', 'node-a2', 'node-a3'])
})

test('a failed save, a damaged fleet file and a damaged settings file are each refused by name', async t => {
  const failed = fixture(t)
  failed.fail.open = 'EIO'
  failed.prefs.set(TREE_KEY, treeDocument('this-computer', [['node-a1']]), { expectedValue: failed.values[TREE_KEY] })
  await failed.prefs.flushFleetDocuments()
  assert.equal(failed.prefs.snapshot().fleetWriteError, 'EIO')
  assert.equal(stored(failed).code, CODES.WRITE_ERROR)
  assert.equal(stored(failed).persistenceFailed, true)

  const fleetDamaged = fixture(t, { fleetText: 'not json{' })
  assert.equal(typeof fleetDamaged.prefs.snapshot().fleetDamaged, 'string')
  assert.equal(stored(fleetDamaged).code, CODES.FLEET_DAMAGED)

  const prefsDamaged = fixture(t, { recordText: 'not json{' })
  assert.equal(typeof prefsDamaged.prefs.snapshot().damaged, 'string')
  assert.equal(stored(prefsDamaged).code, CODES.PREFS_DAMAGED)
  assert.equal(stored(prefsDamaged).persistenceFailed, true)

  // Each health report on its own, over a file that agrees with the cache: the report alone is enough to refuse.
  const reports = [['fleetDamaged', 'the fleet document file could not be read (EIO)', CODES.FLEET_DAMAGED, true], ['damaged', 'the settings file contains malformed JSON', CODES.PREFS_DAMAGED, true],
    ['fleetWriteError', 'EIO', CODES.WRITE_ERROR, true], ['fleetPending', true, CODES.PENDING, false]]
  for (const [report, value, code, persistenceFailed] of reports) {
    const store = readFleetStore({ ...agreeing(baseValues()), rendererPrefs: fakePrefs(healthy(baseValues(), { [report]: value })) })
    assert.equal(store.code, code, report)
    assert.equal(store.persistenceFailed, persistenceFailed, report)
  }
  assert.equal(readFleetStore(agreeing(baseValues())).ok, true)
})

test('a snapshot that does not report its health is refused, never read as healthy', () => {
  const { fleetPending, ...withoutPending } = healthy(baseValues())
  const { fleetDamaged, ...withoutDamaged } = healthy(baseValues())
  const { damaged, ...withoutPrefsDamaged } = healthy(baseValues())
  const { fleetWriteError, ...withoutWriteError } = healthy(baseValues())
  const drifted = { fleetPending: 'no', fleetPending2: 0 }
  for (const snapshot of [withoutPending, withoutDamaged, withoutPrefsDamaged, withoutWriteError, { ...healthy(baseValues()), fleetPending: drifted.fleetPending }, { ...healthy(baseValues()), ok: false }, null, 'text']) {
    const store = readFleetStore({ ...agreeing(baseValues()), rendererPrefs: fakePrefs(snapshot) })
    assert.equal(store.code, CODES.SNAPSHOT_UNREADABLE, JSON.stringify(snapshot))
  }
  const throwing = readFleetStore({ ...agreeing(baseValues()), rendererPrefs: fakePrefs(() => { throw new Error('boom') }) })
  assert.equal(throwing.code, CODES.SNAPSHOT_UNREADABLE)
  for (const unconfigured of [{}, { ...agreeing(baseValues()), storePath: 'relative/renderer-fleet-documents.json' }, { ...agreeing(baseValues()), fs: {} }]) {
    assert.equal(readFleetStore(unconfigured).code, CODES.UNCONFIGURED)
  }
})

test('an absent durable file is empty, not damaged, while a cache that holds trees over no file is a disagreement', t => {
  const none = fixture(t, { values: {}, fleetText: null })
  assert.equal(none.files.has(none.fleetFile), false)
  const store = stored(none)
  assert.equal(store.code, CODES.EMPTY)
  assert.equal(store.persistenceFailed, false)
  const snapshot = snapshotOf(none)
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.persistenceFailed, false)
  assert.equal(snapshot.reason, CODES.EMPTY)
  // A file that exists and holds no documents agrees with an empty cache, and there is still nothing to prune from.
  const emptyFile = fixture(t, { values: {} })
  assert.equal(stored(emptyFile).ok, true)
  assert.equal(snapshotOf(emptyFile).reason, CODES.EMPTY)
  assert.equal(snapshotOf(emptyFile).persistenceFailed, false)
})

test('an unreadable, oversize or non-UTF-8 durable file is refused before anything is parsed', t => {
  for (const code of ['EIO', 'EACCES']) {
    const f = fixture(t)
    f.fail.read = code
    assert.equal(stored(f).code, CODES.FILE_UNREADABLE, code)
    assert.equal(stored(f).persistenceFailed, true, code)
  }
  const givenBytes = bytes => readFleetStore({ ...agreeing({}), fs: { readFileSync: () => bytes } })
  assert.equal(givenBytes(Buffer.allocUnsafe(MAX_FLEET_RECORD_BYTES + 1)).code, CODES.TOO_LARGE)
  // An invalid byte inside a document's value reads as U+FFFD, so a cache that read it the same way "agrees" -- and must still be refused.
  const withValue = value => Buffer.concat([Buffer.from(`{"storageVersion":1,"values":{"${DIFF_KEY}":"`), value, Buffer.from('"}}')])
  const lossy = readFleetStore({ ...agreeing({ [DIFF_KEY]: '�' }), fs: { readFileSync: () => withValue(Buffer.from([0xff])) } })
  assert.equal(lossy.code, CODES.FLEET_DAMAGED)
  assert.equal(readFleetStore({ ...agreeing({ [DIFF_KEY]: 'é' }), fs: { readFileSync: () => withValue(Buffer.from('é', 'utf8')) } }).ok, true)
  assert.equal(givenBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(wrapperOf({}))])).code, CODES.FLEET_DAMAGED)
  assert.equal(givenBytes(Buffer.from(wrapperOf({}))).ok, true, 'the same bytes without the fault are read')
  assert.equal(givenBytes(12345).code, CODES.FILE_UNREADABLE)
})

test('tree documents are validated as the app reads them, and one bad document refuses the whole snapshot', () => {
  const doc = (mutate = () => {}) => { const value = JSON.parse(treeDocument('c', [['node-1']])); mutate(value); return JSON.stringify(value) }
  const many = count => Array.from({ length: count }, (_, i) => ({ id: `node-${i}`, treeId: 'tree-c', status: 'running' }))
  const bad = {
    'not JSON': 'not json{',
    'another version': doc(value => { value.version = 2 }),
    'trees that are not a list': doc(value => { value.trees = {} }),
    'a node in a tree the document does not hold': doc(value => { value.nodes[0].treeId = 'tree-missing' }),
    'an id used twice': doc(value => { value.nodes[0].id = 'tree-c' }),
    'a status this build does not know': doc(value => { value.nodes[0].status = 'paused' }),
    'an id that is not an identifier': doc(value => { value.nodes[0].id = 'node one' }),
    'more nodes than a saved computer may hold': doc(value => { value.nodes = many(4097) }),
    'more trees than a saved computer may hold': doc(value => { value.trees = Array.from({ length: 65 }, (_, i) => ({ id: `tree-${i}` })) }),
  }
  const good = treeDocument('good', [['node-good']])
  assert.equal(readTreeSnapshot(agreeing({ 'mc.fleet.trees.v1:good': good, 'mc.fleet.trees.v1:ok': doc() })).complete, true, 'the same documents without a fault are read')
  for (const [name, value] of Object.entries(bad)) {
    const snapshot = readTreeSnapshot(agreeing({ 'mc.fleet.trees.v1:good': good, 'mc.fleet.trees.v1:bad': value }))
    assert.equal(snapshot.complete, false, name)
    assert.equal(snapshot.persistenceFailed, true, name)
    assert.equal(snapshot.reason, CODES.FLEET_DAMAGED, name)
    assert.deepEqual(snapshot.nodes, [], name)
  }
  // An id is one id across every saved computer: the engine refuses a snapshot that names a node twice.
  const shared = readTreeSnapshot(agreeing({ 'mc.fleet.trees.v1:a': treeDocument('a', [['node-shared']]), 'mc.fleet.trees.v1:b': treeDocument('b', [['node-shared']]) }))
  assert.equal(shared.complete, false)
  assert.equal(shared.reason, CODES.FLEET_DAMAGED)
  // A node may not name a tree from another computer's document.
  const crossed = readTreeSnapshot(agreeing({
    'mc.fleet.trees.v1:a': treeDocument('a', [['node-a']]),
    'mc.fleet.trees.v1:b': JSON.stringify({ version: 1, computerId: 'b', trees: [{ id: 'tree-b' }], nodes: [{ id: 'node-b', treeId: 'tree-a', status: 'running' }] }),
  }))
  assert.equal(crossed.complete, false)
  const merged = readTreeSnapshot(agreeing({ 'mc.fleet.trees.v1:a': treeDocument('a', [['node-a']]), 'mc.fleet.trees.v1:b': treeDocument('b', [['node-b', 'finished']]) }))
  assert.equal(merged.complete, true)
  assert.deepEqual(merged.trees.map(tree => tree.id).sort(), ['tree-a', 'tree-b'])
  assert.deepEqual(merged.nodes.map(node => node.id).sort(), ['node-a', 'node-b'])
})

// ---- fakes for the engine, the repair service and the native surfaces ----

// The engine here is deliberately blind: its scope hash ignores the tree store, so any refusal that follows a change
// to the store is the adapter's own doing. (The real engine's scope hash is checked in the engine-contract test.)
function fakeEngine() {
  const engine = { created: null, calls: [], deletions: [], tokens: new Map(), snapshots: [] }
  const scopeOf = limit => sha(`scope:${limit ?? 100}`)
  const code = (name, message = name) => Object.assign(new Error(message), { code: name })
  const snapshot = () => { const value = engine.created.readTreeSnapshot(); engine.snapshots.push(value); return value }
  const pruner = {
    preview({ limit } = {}) {
      engine.calls.push('preview'); snapshot()
      if (engine.previewError) throw engine.previewError
      return { scopeHash: scopeOf(limit), scanned: 5, eligible: 2, selected: 2, remaining: 0, limit: limit ?? 100, rows: [{ key: 'continuation-1', revision: 1, hash: 'h' }] }
    },
    async prepare({ limit, scopeHash } = {}) {
      engine.calls.push('prepare'); snapshot()
      if (scopeHash !== scopeOf(limit)) throw code('CONTINUATION_PRUNE_CHANGED', 'Saved state changed; review a new prune preview.')
      const token = `token-${engine.tokens.size + 1}`
      engine.tokens.set(token, { limit, scopeHash })
      if (engine.duringPrepare) await engine.duringPrepare()
      return { ok: true, token, scopeHash, backup: '/state/toolsenabled.sqlite3.before-prune-x.sqlite3', selected: 2, remaining: 0, scanned: 5, limit: limit ?? 100 }
    },
    async confirm({ token } = {}, confirmOwner) {
      engine.calls.push('confirm')
      const planned = engine.tokens.get(token)
      if (!planned) throw code('CONTINUATION_PRUNE_PREVIEW_REQUIRED', 'The preview is missing, used or expired. Nothing was removed.')
      engine.tokens.delete(token); snapshot()
      if (engine.beforeDialog) await engine.beforeDialog()
      const approved = await confirmOwner({ scopeHash: planned.scopeHash, backup: '/state/toolsenabled.sqlite3.before-prune-x.sqlite3', selected: 2, remaining: 0, limit: planned.limit ?? 100 })
      if (approved !== true) throw code('CONTINUATION_PRUNE_CANCELLED', 'The owner did not confirm this removal. Nothing was removed.')
      snapshot()
      engine.deletions.push(token)
      return { ok: true, removed: 2, remaining: 0, backup: '/state/toolsenabled.sqlite3.before-prune-x.sqlite3', rows: ['internal'] }
    },
  }
  engine.requireModule = modulePath => (modulePath.endsWith('continuation-prune.js')
    ? { createContinuationPruner: args => { engine.created = args; return Object.freeze(pruner) } }
    : { DEFAULT_STATE_PATH: '/state/toolsenabled.sqlite3' })
  return engine
}

// A repair service that follows the real one's protocol: the same callbacks, phases and payload shapes.
function fakeRepairService(f, hooks = {}) {
  const calls = []
  const pending = new Map()
  let serial = 0
  const repairedDocument = treeDocument('this-computer', [['node-a1', 'finished'], ['node-a2', 'finished']])
  const replacement = () => hooks.replacement ?? wrapperOf({ ...f.values, [TREE_KEY]: repairedDocument })
  const backupPath = `${f.fleetFile}.repair-backup-20260921T200000Z-0123456789abcdef.json`
  const safetyBackupPath = `${f.fleetFile}.repair-backup-20260921T200500Z-89abcdef01234567.json`
  const failed = (code, reason = code) => ({ ok: false, code, reason })
  const meta = text => ({ sha256: sha(text), bytes: Buffer.byteLength(text), revision: { size: Buffer.byteLength(text), mtimeMs: 1 } })
  // The staging and the commit, as the real service reaches them: its callbacks, in its order, with the plan's own fields in each payload.
  async function stageAndCommit(args, plan, text) {
    for (const phase of ['stage', 'commit']) {
      const payload = { ...plan, phase, expectedText: f.disk(), replacementText: text }
      if (args.freshnessCheck(payload) !== true) return failed('FRESHNESS_REFUSED', `The renderer-prefs fleet cache was pending, damaged, or changed; ${phase} was refused.`)
    }
    if (hooks.skipCommit) return null
    const committed = args.commitReplacement({ expectedText: f.disk(), replacementText: text })
    if (hooks.commitCalls) hooks.commitCalls.push(committed)
    if (!(committed === true || committed?.ok === true)) return failed(committed?.error?.code || 'SYNCHRONOUS_COMMIT_REFUSED', committed?.error?.message)
    return null
  }
  const service = {
    REPAIR_ACTION: realRepairService.REPAIR_ACTION,
    ROLLBACK_ACTION: realRepairService.ROLLBACK_ACTION,
    MAX_TARGETS: realRepairService.MAX_TARGETS,
    async prepareRepair(args) {
      calls.push({ method: 'prepareRepair', args })
      if (hooks.prepareError) throw hooks.prepareError
      if (hooks.beforeFreshness) await hooks.beforeFreshness(args)
      const fresh = args.freshnessCheck({ action: args.action, phase: 'backup', storePath: args.storePath, snapshotPath: args.snapshotPath, valueKey: args.valueKey })
      if (fresh !== true) return failed('FRESHNESS_REFUSED', 'The renderer-prefs fleet cache was pending, damaged, or changed; dated backup was refused.')
      if (Object.hasOwn(hooks, 'prepareResult')) return hooks.prepareResult
      const plan = { schemaVersion: 1, action: args.action, storePath: args.storePath, snapshotPath: args.snapshotPath, sourceSha256: hooks.sourceSha256 ?? sha(f.disk()),
        changes: [{ valueKey: TREE_KEY, nodeId: 'node-a1' }], skipped: [], backupPath, backupSha256: sha(f.disk()), planHash: 'a'.repeat(64) }
      const previewToken = `preview-${++serial}`
      pending.set(previewToken, plan)
      return { ok: true, previewToken, plan, preview: { changes: plan.changes, skipped: [], backupPath } }
    },
    async confirmRepair(args) {
      calls.push({ method: 'confirmRepair', args })
      if (hooks.confirmError) throw hooks.confirmError
      if (Object.hasOwn(hooks, 'confirmResult')) return hooks.confirmResult
      const plan = pending.get(args.previewToken)
      if (!plan) return failed('PREVIEW_MISSING', 'The owner-action repair preview token is missing or unknown.')
      pending.delete(args.previewToken)
      if (hooks.beforeNative) await hooks.beforeNative()
      const approval = hooks.skipNative ? true : await args.confirmNative({ action: plan.action, planHash: plan.planHash, storePath: plan.storePath, snapshotPath: plan.snapshotPath, valueKeys: [TREE_KEY],
        changes: plan.changes, skipped: plan.skipped, backupPath: plan.backupPath, backupSha256: plan.backupSha256, seatChanges: [], notRestorableSeats: [] })
      if (approval !== true) return failed('NATIVE_CONFIRM_REFUSED', 'The trusted native owner dialog did not approve the saved-node repair.')
      if (hooks.afterApproval) await hooks.afterApproval()
      const problem = await stageAndCommit(args, plan, replacement())
      if (problem) return problem
      if (hooks.afterCommit) await hooks.afterCommit()
      return { ok: true, planHash: plan.planHash, backupPath: plan.backupPath, restoredNodeIds: plan.changes.map(change => change.nodeId), changes: hooks.changes ?? plan.changes,
        skipped: [], seatChanges: [], notRestorableSeats: [], postWriteSha256: hooks.postWriteSha256 ?? sha(hooks.skipCommit ? replacement() : f.disk()),
        postWriteVerified: hooks.postWriteVerified ?? true }
    },
    async prepareRollback(args) {
      calls.push({ method: 'prepareRollback', args })
      if (hooks.prepareError) throw hooks.prepareError
      const fresh = args.freshnessCheck({ action: args.action, phase: 'safety-backup', storePath: args.storePath, restorePath: args.restorePath })
      if (fresh !== true) return failed('FRESHNESS_REFUSED', 'The renderer-prefs fleet cache was pending, damaged, or changed; rollback safety backup was refused.')
      if (Object.hasOwn(hooks, 'prepareRollbackResult')) return hooks.prepareRollbackResult
      const restoreText = f.files.get(args.restorePath)
      const source = f.disk()
      const plan = { schemaVersion: 1, action: args.action, trigger: 'owner-action', storeFormat: 'renderer-fleet-documents.values-json-string', storePath: args.storePath,
        restorePath: args.restorePath, restore: hooks.restore ?? meta(restoreText), source: hooks.source ?? meta(source), safetyBackupPath, safetyBackup: meta(source),
        createdAt: '2026-09-21T20:00:00.000Z', planHash: 'b'.repeat(64) }
      const previewToken = `rollback-${++serial}`
      pending.set(previewToken, { plan, restoreText })
      return { ok: true, previewToken, plan, preview: { sourceSha256: plan.source.sha256, restorePath: args.restorePath, safetyBackupPath } }
    },
    async confirmRollback(args) {
      calls.push({ method: 'confirmRollback', args })
      if (hooks.confirmError) throw hooks.confirmError
      if (Object.hasOwn(hooks, 'confirmResult')) return hooks.confirmResult
      const entry = pending.get(args.previewToken)
      if (!entry) return failed('PREVIEW_MISSING', 'The rollback preview token is missing or unknown.')
      pending.delete(args.previewToken)
      if (hooks.beforeNative) await hooks.beforeNative()
      const approval = hooks.skipNative ? true : await args.confirmNative({ action: entry.plan.action, planHash: entry.plan.planHash, storePath: entry.plan.storePath,
        restorePath: entry.plan.restorePath, restoreSha256: entry.plan.restore.sha256, safetyBackupPath })
      if (approval !== true) return failed('NATIVE_CONFIRM_REFUSED', 'The trusted native owner dialog did not approve the rollback.')
      if (hooks.afterApproval) await hooks.afterApproval()
      const text = hooks.rollbackReplacement ?? entry.restoreText
      const problem = await stageAndCommit(args, entry.plan, text)
      if (problem) return problem
      if (hooks.afterCommit) await hooks.afterCommit()
      return { ok: true, planHash: entry.plan.planHash, restorePath: entry.plan.restorePath, safetyBackupPath,
        postWriteSha256: hooks.postWriteSha256 ?? sha(hooks.skipCommit ? text : f.disk()), postWriteVerified: hooks.postWriteVerified ?? true }
    },
  }
  return { service, calls, repairedDocument, replacement, backupPath, safetyBackupPath }
}

function harness(t, options = {}) {
  const { fixtureOptions, adapter: overrides = {}, hooks = {}, answer = 1 } = options
  const snapshotPath = Object.hasOwn(options, 'snapshotPath') ? options.snapshotPath : '/chosen/saved-snapshot.json'
  const f = fixture(t, fixtureOptions)
  const engine = fakeEngine()
  const repair = fakeRepairService(f, hooks)
  const state = { answer, snapshotPath, backup: null, dialogs: [], pickers: 0, rollbackPickers: 0, onDialog: null, onPick: null }
  const dialog = { async showMessageBox(parent, spec) { state.dialogs.push(spec); if (state.onDialog) await state.onDialog(spec); return { response: state.answer } } }
  const chooseSnapshotFile = async () => { state.pickers += 1; if (state.onPick) await state.onPick(); if (state.pickerError) throw state.pickerError; return state.snapshotPath }
  const chooseRollbackFile = async () => { state.rollbackPickers += 1; if (state.onPick) await state.onPick(); if (state.rollbackPickerError) throw state.rollbackPickerError; return state.backup }
  const clock = { at: Date.parse('2026-09-21T20:00:00.000Z') }
  const adapter = createSavedDataMaintenanceAdapter({
    resolveCapabilityRoot: () => '/engine-root', requireModule: engine.requireModule, dialog, chooseSnapshotFile, chooseRollbackFile, repairService: repair.service,
    rendererPrefs: f.prefs, fleetStorePath: f.fleetFile, fs: f.fs, now: () => new Date(clock.at), ...overrides,
  })
  return { f, engine, repair, state, clock, adapter }
}
// A dated repair backup in the in-memory filesystem: the store's own documents with these nodes (or these values, or this text) in the tree.
function backupOf(h, { nodes, values, text, stamp = '0000Z' } = {}) {
  const content = text ?? wrapperOf(values ?? { ...h.f.values, [TREE_KEY]: treeDocument('this-computer', nodes) })
  const file = `${h.f.fleetFile}.repair-backup-20260921T19${stamp}-fedcba9876543210.json`
  h.f.files.set(file, content)
  return file
}
const preview = async (h, limit) => h.adapter.continuationPrunePreview(limit === undefined ? {} : { limit }, person)
const prepare = async (h, reviewed) => h.adapter.continuationPruneConfirm({ stage: 'prepare', limit: reviewed.limit, scopeHash: reviewed.scopeHash }, person)
const confirm = async (h, prepared) => h.adapter.continuationPruneConfirm({ stage: 'confirm', token: prepared.token }, person)
async function prepared(h) { const reviewed = await preview(h); assert.equal(reviewed.ok, true); const result = await prepare(h, reviewed); assert.equal(result.ok, true); return { reviewed, result } }
const editTrees = (f, nodes) => save(f, TREE_KEY, treeDocument('this-computer', nodes))

// ---- who may ask, and how the adapter is built ----

test('the person is a live window principal that may write, and nothing else is', () => {
  assert.equal(isPerson(livePerson()), true)
  const owner = { isDestroyed: () => false }
  for (const [name, principal] of Object.entries({
    'a relay, even one that may write': { kind: 'relay', mayWrite: true, owner },
    'an agent': { kind: 'agent', mayWrite: true, owner },
    'an mcp caller': { kind: 'mcp', mayWrite: true, owner },
    'an api caller': { kind: 'api', mayWrite: true, owner },
    'a window that may not write': { kind: 'window', mayWrite: false, owner },
    'a window whose write permission is not exactly true': { kind: 'window', mayWrite: 'yes', owner },
    'a window without a write permission': { kind: 'window', owner },
    'a window without an owner': { kind: 'window', mayWrite: true },
    'a window whose owner is not an object': { kind: 'window', mayWrite: true, owner: 'window-1' },
    'a window whose owner is destroyed': { kind: 'window', mayWrite: true, owner: { isDestroyed: () => true } },
    'a window whose owner cannot say': { kind: 'window', mayWrite: true, owner: {} },
    'a window whose owner throws when asked': { kind: 'window', mayWrite: true, owner: { isDestroyed() { throw new Error('gone') } } },
    'a window whose owner answers something other than false': { kind: 'window', mayWrite: true, owner: { isDestroyed: () => undefined } },
    'no principal': undefined, 'a null principal': null, 'a string': 'window', 'a list': [],
  })) assert.equal(isPerson(principal), false, name)
})

test('every route is for the person only and refuses, returned by name, before it touches the engine, the service, a picker or a dialog', async t => {
  const h = harness(t)
  const routes = [['continuationPrunePreview', {}], ['continuationPruneConfirm', { stage: 'prepare', scopeHash: 'a'.repeat(64) }],
    ['nodeStatusRepairPreview', {}], ['nodeStatusRepairConfirm', { previewToken: 'token' }], ['nodeStatusRollbackPreview', {}], ['nodeStatusRollbackConfirm', { previewToken: 'token' }]]
  const owner = { isDestroyed: () => false }
  const callers = [{ kind: 'agent', label: 'a caller' }, { kind: 'mcp', mayWrite: true, owner }, { kind: 'relay', mayWrite: true, owner }, { kind: 'window', mayWrite: false, owner },
    { kind: 'window', mayWrite: true }, { kind: 'window', mayWrite: true, owner: { isDestroyed: () => true } }, undefined, null]
  for (const caller of callers) {
    for (const [route, payload] of routes) {
      const result = await h.adapter[route](payload, caller)
      assert.deepEqual(result, { ok: false, code: CODES.PERSON_REQUIRED, reason: result.reason }, `${route} ${JSON.stringify(caller)}`)
      assert.match(result.reason, /person using this app window/)
    }
  }
  assert.deepEqual(h.engine.calls, [])
  assert.deepEqual(h.repair.calls, [])
  assert.equal(h.state.pickers + h.state.rollbackPickers, 0)
  assert.equal(h.state.dialogs.length, 0)
})

test('the person leaving while the adapter waits stops it: after a picker, while a dialog is open, and before anything is staged', async t => {
  // A picker that closes the window before it answers.
  for (const [route, picker] of [['nodeStatusRepairPreview', 'pickers'], ['nodeStatusRollbackPreview', 'rollbackPickers']]) {
    const h = harness(t)
    h.state.backup = backupOf(h, { nodes: [['node-a1', 'finished'], ['node-a2', 'turn-failed']] })
    const leaving = livePerson()
    h.state.onPick = () => { leaving.owner.destroyed = true }
    const result = await h.adapter[route]({}, leaving)
    assert.equal(result.code, CODES.PERSON_REQUIRED, route)
    assert.equal(h.state[picker], 1, route)
    assert.deepEqual(h.repair.calls, [], route)
  }
  // A native dialog left open while the window closes: the approval is not honoured.
  const pruning = harness(t)
  const { result: made } = await prepared(pruning)
  const closing = livePerson()
  pruning.state.onDialog = () => { closing.owner.destroyed = true }
  const pruneAnswer = await pruning.adapter.continuationPruneConfirm({ stage: 'confirm', token: made.token }, closing)
  assert.equal(pruneAnswer.code, CODES.PERSON_REQUIRED)
  assert.equal(pruning.state.dialogs.length, 1)
  assert.equal(pruning.engine.deletions.length, 0)
  for (const [preview, confirmRoute, extra] of [['nodeStatusRepairPreview', 'nodeStatusRepairConfirm', {}], ['nodeStatusRollbackPreview', 'nodeStatusRollbackConfirm', { backup: true }]]) {
    const h = harness(t)
    if (extra.backup) h.state.backup = backupOf(h, { nodes: [['node-a1', 'finished'], ['node-a2', 'turn-failed']] })
    const reviewed = await h.adapter[preview]({}, person)
    assert.equal(reviewed.ok, true, preview)
    const before = h.f.disk()
    const window = livePerson()
    h.state.onDialog = () => { window.owner.destroyed = true }
    const answer = await h.adapter[confirmRoute]({ previewToken: reviewed.previewToken }, window)
    assert.equal(answer.ok, false, confirmRoute)
    assert.equal(answer.fleetGate.code, CODES.PERSON_REQUIRED, confirmRoute)
    assert.equal(h.f.disk(), before, confirmRoute)
    // And one that leaves after the person approved, before the service stages: the service's own callback refuses.
    const late = harness(t, { hooks: { afterApproval: () => { gone.owner.destroyed = true } } })
    if (extra.backup) late.state.backup = backupOf(late, { nodes: [['node-a1', 'finished'], ['node-a2', 'turn-failed']] })
    const gone = livePerson()
    const lateReview = await late.adapter[preview]({}, gone)
    const lateBefore = late.f.disk()
    const stopped = await late.adapter[confirmRoute]({ previewToken: lateReview.previewToken }, gone)
    assert.equal(stopped.ok, false, confirmRoute)
    assert.equal(stopped.code, 'FRESHNESS_REFUSED', confirmRoute)
    assert.equal(stopped.fleetGate.code, CODES.PERSON_REQUIRED, confirmRoute)
    assert.equal(late.f.disk(), lateBefore, confirmRoute)
  }
})

test('an adapter cannot be built without what it must check, or over a file that is not the fleet file', t => {
  const f = fixture(t)
  const complete = { resolveCapabilityRoot: () => '/engine-root', requireModule: () => ({}), rendererPrefs: f.prefs, fleetStorePath: f.fleetFile }
  assert.equal(typeof createSavedDataMaintenanceAdapter(complete).continuationPrunePreview, 'function')
  const withoutSeam = { snapshot: f.prefs.snapshot }
  for (const broken of [{ resolveCapabilityRoot: undefined }, { requireModule: undefined }, { rendererPrefs: undefined }, { rendererPrefs: withoutSeam },
    { fleetStorePath: undefined }, { fleetStorePath: 'renderer-fleet-documents.json' }, { fleetStorePath: path.join(f.directory, RECORD_FILE) },
    { stateFile: 'relative.sqlite3' }, { stateFile: '' }, { stateFile: 5 }]) {
    assert.throws(() => createSavedDataMaintenanceAdapter({ ...complete, ...broken }), { code: 'MC_SAVED_DATA_MAINTENANCE_CONFIGURATION' }, JSON.stringify(Object.keys(broken)))
  }
  assert.throws(() => createSavedDataMaintenanceAdapter(), { code: 'MC_SAVED_DATA_MAINTENANCE_CONFIGURATION' })
})

// ---- continuation prune ----

test('prune preview reports the engine unavailable, by name, when it cannot be resolved', async t => {
  for (const overrides of [{ resolveCapabilityRoot: () => null }, { requireModule: () => { throw new Error('unreachable') } }, { requireModule: () => ({}) }]) {
    const h = harness(t, { adapter: overrides })
    for (const result of [await preview(h), await h.adapter.continuationPruneConfirm({ stage: 'prepare', scopeHash: 'a'.repeat(64) }, person)]) {
      assert.equal(result.ok, false)
      assert.equal(result.code, 'AGENT_CONTINUATION_PRUNE_UNAVAILABLE')
    }
  }
})

test('prune refuses, before the engine is asked, while the store is unsettled or does not agree with its cache', async t => {
  const pending = harness(t)
  pending.f.prefs.set(TREE_KEY, treeDocument('this-computer', [['node-a1']]), { expectedValue: pending.f.values[TREE_KEY] })
  const diverged = harness(t)
  diverged.f.files.set(diverged.f.fleetFile, wrapperOf({ ...diverged.f.values, [DIFF_KEY]: 'written by someone else' }))
  const damaged = harness(t, { fixtureOptions: { fleetText: 'not json{' } })
  for (const [h, code] of [[pending, CODES.PENDING], [diverged, CODES.DISAGREES], [damaged, CODES.FLEET_DAMAGED]]) {
    const result = await preview(h)
    assert.equal(result.ok, false, code)
    assert.equal(result.code, code)
    assert.match(result.reason, /Nothing was changed/)
    assert.deepEqual(h.engine.calls, [], code)
    assert.equal((await h.adapter.continuationPruneConfirm({ stage: 'prepare', scopeHash: 'a'.repeat(64) }, person)).ok, false)
    assert.deepEqual(h.engine.calls, [], code)
  }
})

test('prune preview hands the engine the complete-store snapshot and returns only the summary, bound to the store it read', async t => {
  const h = harness(t)
  const result = await preview(h)
  assert.deepEqual(Object.keys(result).sort(), ['eligible', 'fleetSha256', 'limit', 'ok', 'remaining', 'scanned', 'scopeHash', 'selected'])
  assert.equal(result.ok, true)
  assert.equal(result.fleetSha256, sha(h.f.disk()))
  assert.equal(result.eligible, 2)
  const seen = h.engine.snapshots.at(-1)
  assert.equal(seen.complete, true)
  assert.equal(seen.revision, result.fleetSha256)
  assert.deepEqual(seen.nodes.map(node => node.id), ['node-a1', 'node-a2'])
  assert.equal((await preview(h, 10)).limit, 10)
})

test('prune prepare needs a scope hash this adapter previewed', async t => {
  const h = harness(t)
  const reviewed = await preview(h)
  for (const scopeHash of [undefined, null, '', 'abc', 42, 'g'.repeat(64), 'A'.repeat(64)]) {
    const result = await h.adapter.continuationPruneConfirm({ stage: 'prepare', scopeHash }, person)
    assert.equal(result.ok, false, String(scopeHash))
    assert.equal(result.code, 'MC_AGENT_INVALID_PAYLOAD', String(scopeHash))
  }
  const unknown = await h.adapter.continuationPruneConfirm({ stage: 'prepare', scopeHash: 'f'.repeat(64) }, person)
  assert.equal(unknown.code, 'CONTINUATION_PRUNE_PREVIEW_REQUIRED')
  assert.equal(h.engine.calls.includes('prepare'), false)
  assert.equal((await prepare(h, reviewed)).ok, true)
  assert.equal((await h.adapter.continuationPruneConfirm({ stage: 'nonsense' }, person)).code, 'MC_AGENT_INVALID_PAYLOAD')
})

test('prune prepare refuses when the saved trees changed after the preview, even where the engine would not notice', async t => {
  const h = harness(t)
  const reviewed = await preview(h)
  await editTrees(h.f, [['node-a1'], ['node-a2', 'finished'], ['node-a3']])
  const result = await prepare(h, reviewed)
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.CHANGED)
  assert.equal(h.engine.calls.includes('prepare'), false)
  assert.equal(h.engine.tokens.size, 0)
  // A chat diff is part of the store too.
  const h2 = harness(t)
  const reviewed2 = await preview(h2)
  await save(h2.f, DIFF_KEY, 'a later chat diff')
  assert.equal((await prepare(h2, reviewed2)).code, CODES.CHANGED)
  // A new review of the changed store is honoured.
  const again = await preview(h)
  assert.equal((await prepare(h, again)).ok, true)
})

test('prune confirm needs the token this adapter handed out, once, and only while the reviewed store is unchanged', async t => {
  const h = harness(t)
  const { result } = await prepared(h)
  assert.equal(result.fleetSha256, sha(h.f.disk()))
  const unknown = await h.adapter.continuationPruneConfirm({ stage: 'confirm', token: 'not-a-token' }, person)
  assert.equal(unknown.code, 'CONTINUATION_PRUNE_PREVIEW_REQUIRED')
  for (const token of [undefined, '', 7, 'x'.repeat(300)]) assert.equal((await h.adapter.continuationPruneConfirm({ stage: 'confirm', token }, person)).code, 'MC_AGENT_INVALID_PAYLOAD')
  assert.equal(h.engine.calls.includes('confirm'), false)
  assert.equal(h.state.dialogs.length, 0)

  const done = await confirm(h, result)
  assert.deepEqual(done, { ok: true, removed: 2, remaining: 0, backup: '/state/toolsenabled.sqlite3.before-prune-x.sqlite3', fleetSha256: sha(h.f.disk()) })
  assert.equal(h.engine.deletions.length, 1)
  assert.equal((await confirm(h, result)).code, 'CONTINUATION_PRUNE_PREVIEW_REQUIRED')
  assert.equal(h.engine.deletions.length, 1)
  assert.equal(h.engine.calls.filter(call => call === 'confirm').length, 1, 'the second confirmation was refused before it reached the engine')
})

test('a store that changes while the engine is making its copy gets no token the adapter will honour', async t => {
  const h = harness(t)
  const reviewed = await preview(h)
  h.engine.duringPrepare = () => editTrees(h.f, [['node-a1'], ['node-a2', 'finished'], ['node-a8']])
  const result = await prepare(h, reviewed)
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.CHANGED)
  assert.equal(result.token, undefined)
  // The engine minted a token for the store it copied; it was never handed on, and asking for it is refused before the engine or a dialog.
  const [minted] = h.engine.tokens.keys()
  assert.equal(typeof minted, 'string')
  assert.equal((await h.adapter.continuationPruneConfirm({ stage: 'confirm', token: minted }, person)).code, 'CONTINUATION_PRUNE_PREVIEW_REQUIRED')
  assert.equal(h.engine.calls.includes('confirm'), false)
  assert.equal(h.state.dialogs.length, 0)
})

test('a change after the confirmation started and before the dialog shows the person nothing', async t => {
  const h = harness(t)
  const { result } = await prepared(h)
  h.engine.beforeDialog = () => editTrees(h.f, [['node-a1'], ['node-a2', 'finished'], ['node-a9']])
  const refused = await confirm(h, result)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, CODES.CHANGED)
  assert.equal(h.state.dialogs.length, 0)
  assert.equal(h.engine.deletions.length, 0)
})

test('prune confirm refuses before the dialog when the store changed between the backup and the confirmation', async t => {
  const h = harness(t)
  const { result } = await prepared(h)
  await editTrees(h.f, [['node-a1']])
  const refused = await confirm(h, result)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, CODES.CHANGED)
  assert.equal(h.engine.calls.includes('confirm'), false)
  assert.equal(h.state.dialogs.length, 0)
  assert.equal(h.engine.deletions.length, 0)
})

test('an approval given while the saved trees were changing is not honoured', async t => {
  const h = harness(t)
  const { result } = await prepared(h)
  h.state.onDialog = () => editTrees(h.f, [['node-a1'], ['node-a2', 'finished'], ['node-a4']])
  const refused = await confirm(h, result)
  assert.equal(h.state.dialogs.length, 1, 'the person was asked about the store they had reviewed')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, CODES.CHANGED)
  assert.equal(h.engine.deletions.length, 0)
})

test('the native dialog decides: cancelling, a closed dialog and a headless run remove nothing', async t => {
  const cancelled = harness(t, { answer: 0 })
  const notApproved = await confirm(cancelled, (await prepared(cancelled)).result)
  assert.equal(notApproved.code, 'CONTINUATION_PRUNE_CANCELLED')
  assert.equal(cancelled.engine.deletions.length, 0)

  process.env.MC_SMOKE_HEADLESS = '1'
  try {
    const headless = harness(t)
    const result = await confirm(headless, (await prepared(headless)).result)
    assert.equal(result.code, 'CONTINUATION_PRUNE_CANCELLED')
    assert.equal(headless.state.dialogs.length, 0, 'a headless run never shows, and never answers, the dialog')
    assert.equal(headless.engine.deletions.length, 0)
  } finally { delete process.env.MC_SMOKE_HEADLESS }

  const approved = harness(t)
  assert.equal((await confirm(approved, (await prepared(approved)).result)).ok, true)
  assert.equal(approved.state.dialogs.length, 1)
  assert.equal(approved.engine.deletions.length, 1)
})

test('a preview or token older than its lifetime is not honoured', async t => {
  const h = harness(t)
  const reviewed = await preview(h)
  h.clock.at += 10 * 60 * 1000 + 1
  assert.equal((await prepare(h, reviewed)).code, 'CONTINUATION_PRUNE_PREVIEW_REQUIRED')
  const again = await preview(h)
  const made = await prepare(h, again)
  assert.equal(made.ok, true)
  h.clock.at += 10 * 60 * 1000 + 1
  assert.equal((await confirm(h, made)).code, 'CONTINUATION_PRUNE_PREVIEW_REQUIRED')
  assert.equal(h.engine.calls.includes('confirm'), false)
})

test('only the engine\'s own refusals and this adapter\'s are worded for the page; anything else is not shown', async t => {
  const h = harness(t)
  h.engine.previewError = Object.assign(new Error('SQLITE_IOERR: disk I/O error at /home/redacted-profile/private/toolsenabled.sqlite3'), { code: 'ERR_SQLITE_ERROR' })
  const generic = await preview(h)
  assert.equal(generic.ok, false)
  assert.equal(generic.code, 'AGENT_CONTINUATION_PRUNE_FAILED')
  assert.doesNotMatch(JSON.stringify(generic), /SQLITE|someone|private/)
  h.engine.previewError = Object.assign(new Error('Saved state changed; review a new prune preview. Nothing was removed.'), { code: 'CONTINUATION_PRUNE_CHANGED' })
  const named = await preview(h)
  assert.deepEqual([named.code, named.reason], ['CONTINUATION_PRUNE_CHANGED', 'Saved state changed; review a new prune preview. Nothing was removed.'])
})

test('two adapters built over different stores never see each other\'s trees', async t => {
  const x = harness(t, { fixtureOptions: { values: { [TREE_KEY]: treeDocument('this-computer', [['node-x']]) } } })
  const y = harness(t, { fixtureOptions: { values: { [TREE_KEY]: treeDocument('this-computer', [['node-y']]) } } })
  await preview(y)
  await preview(x)
  assert.deepEqual(x.engine.snapshots.at(-1).nodes.map(node => node.id), ['node-x'])
  assert.deepEqual(y.engine.snapshots.at(-1).nodes.map(node => node.id), ['node-y'])
  assert.notEqual(x.engine.snapshots.at(-1).revision, y.engine.snapshots.at(-1).revision)
})

test('the prune targets the state file it was told, else the one the engine itself would open', async t => {
  const told = harness(t, { adapter: { stateFile: '/live/state/toolsenabled.sqlite3' } })
  await preview(told)
  assert.equal(told.engine.created.file, '/live/state/toolsenabled.sqlite3')
  const byDefault = harness(t)
  await preview(byDefault)
  assert.equal(byDefault.engine.created.file, '/state/toolsenabled.sqlite3')
  process.env.TOOLSENABLED_STATE_PATH = ' /environment/state.sqlite3 '
  try {
    const fromEnvironment = harness(t)
    await preview(fromEnvironment)
    assert.equal(fromEnvironment.engine.created.file, '/environment/state.sqlite3')
    const named = harness(t, { adapter: { stateFile: '/live/state/toolsenabled.sqlite3' } })
    await preview(named)
    assert.equal(named.engine.created.file, '/live/state/toolsenabled.sqlite3', 'a state file the caller names wins over the environment')
  } finally { delete process.env.TOOLSENABLED_STATE_PATH }
})

test('the prune dialog names the dated backup as the way back, defaults to Cancel, and only its second button approves', async () => {
  let spec = null
  const dialog = { showMessageBox: async (window, options) => { spec = options; return { response: spec.answer ?? 1 } } }
  const plan = { backup: '/x/before-prune-y.sqlite3', selected: 3, remaining: 2, limit: 100 }
  assert.equal(await createNativeConfirmOwner({ dialog })(plan), true)
  assert.doesNotMatch(spec.detail, /cannot be undone/i)
  assert.match(spec.detail, /before-prune-y\.sqlite3/)
  assert.match(spec.detail, /restore the database from the backup path/i)
  assert.match(spec.detail, /Selected 3 rows.*up to 100 per action/)
  assert.deepEqual([spec.buttons[0], spec.cancelId, spec.defaultId], ['Cancel', 0, 0])
  for (const answer of [{ response: 0 }, { response: 2 }, { response: '1' }, {}, undefined, null]) {
    assert.notEqual(await createNativeConfirmOwner({ dialog: { showMessageBox: async () => answer } })(plan), true, JSON.stringify(answer))
  }
  assert.equal(await createNativeConfirmOwner({ dialog: null })(plan), false)
})

// ---- node status repair, on the guarded snapshot service ----

test('repair is unavailable, by name, without the service or the native picker', async t => {
  const noPicker = harness(t)
  const bare = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: noPicker.engine.requireModule, dialog: null,
    rendererPrefs: noPicker.f.prefs, fleetStorePath: noPicker.f.fleetFile, fs: noPicker.f.fs, repairService: noPicker.repair.service })
  const unusable = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: noPicker.engine.requireModule, dialog: null,
    rendererPrefs: noPicker.f.prefs, fleetStorePath: noPicker.f.fleetFile, fs: noPicker.f.fs, repairService: {}, chooseSnapshotFile: async () => '/chosen/saved-snapshot.json' })
  assert.equal((await bare.nodeStatusRepairPreview({}, person)).code, 'AGENT_NODE_STATUS_REPAIR_UNAVAILABLE')
  assert.equal((await unusable.nodeStatusRepairPreview({}, person)).code, 'AGENT_NODE_STATUS_REPAIR_UNAVAILABLE')
  assert.equal((await unusable.nodeStatusRepairConfirm({ previewToken: 'token' }, person)).code, 'AGENT_NODE_STATUS_REPAIR_UNAVAILABLE')
  assert.deepEqual(noPicker.repair.calls, [])
  // With both, it is available.
  const ready = harness(t)
  assert.equal((await ready.adapter.nodeStatusRepairPreview({}, person)).ok, true)
})

test('the repair scope may name nodes and one fleet tree, nothing else', async t => {
  const h = harness(t)
  const scopes = [{ targetIds: 'node-a1' }, { targetIds: [] }, { targetIds: ['node-a1', 7] }, { targetIds: [''] }, { targetIds: ['x'.repeat(201)] },
    { targetIds: Array.from({ length: realRepairService.MAX_TARGETS + 1 }, (_, i) => `node-${i}`) }, { valueKey: 'mc.fleet.chat-diffs.v1:synthetic-node' }, { valueKey: 7 }]
  for (const scope of scopes) {
    const result = await h.adapter.nodeStatusRepairPreview(scope, person)
    assert.equal(result.code, 'MC_AGENT_INVALID_PAYLOAD', JSON.stringify(scope).slice(0, 60))
  }
  assert.equal(h.state.pickers, 0)
  assert.deepEqual(h.repair.calls, [])
})

test('repair preview refuses before the picker and the service while the store is unsettled or disagrees with its cache', async t => {
  const pending = harness(t)
  pending.f.prefs.set(TREE_KEY, treeDocument('this-computer', [['node-a1']]), { expectedValue: pending.f.values[TREE_KEY] })
  const diverged = harness(t)
  diverged.f.files.delete(diverged.f.fleetFile)
  const failedSave = harness(t)
  failedSave.f.fail.open = 'EIO'
  failedSave.f.prefs.set(TREE_KEY, treeDocument('this-computer', [['node-a1']]), { expectedValue: failedSave.f.values[TREE_KEY] })
  await failedSave.f.prefs.flushFleetDocuments()
  for (const [h, code] of [[pending, CODES.PENDING], [diverged, CODES.DISAGREES], [failedSave, CODES.WRITE_ERROR]]) {
    const result = await h.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
    assert.equal(result.ok, false, code)
    assert.equal(result.code, code)
    assert.equal(h.state.pickers, 0, code)
    assert.deepEqual(h.repair.calls, [], code)
  }
})

test('the snapshot is chosen only by the native picker; the page cannot name a path', async t => {
  const h = harness(t)
  const result = await h.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'], snapshotPath: '/etc/passwd', storePath: '/etc/shadow', backupPath: '/tmp/x' }, person)
  assert.equal(result.ok, true)
  assert.equal(h.state.pickers, 1)
  const { args } = h.repair.calls[0]
  assert.equal(args.snapshotPath, '/chosen/saved-snapshot.json')
  assert.equal(args.storePath, h.f.fleetFile)
  for (const chosen of [null, undefined, '', 'relative/snapshot.json', 42]) {
    const nothing = harness(t, { snapshotPath: chosen })
    const refused = await nothing.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
    assert.equal(refused.code, 'MC_SAVED_DATA_SNAPSHOT_NOT_CHOSEN', String(chosen))
    assert.deepEqual(nothing.repair.calls, [], String(chosen))
  }
  const broken = harness(t)
  broken.state.pickerError = new Error('picker failed')
  assert.equal((await broken.adapter.nodeStatusRepairPreview({}, person)).code, 'MC_SAVED_DATA_SNAPSHOT_NOT_CHOSEN')
  assert.deepEqual(broken.repair.calls, [])
})

test('repair calls the guarded snapshot service by its literal API and returns what it reported', async t => {
  const h = harness(t)
  const result = await h.adapter.nodeStatusRepairPreview({ targetIds: ['node-a2', 'node-a1'], valueKey: TREE_KEY }, person)
  assert.equal(result.ok, true)
  const { args } = h.repair.calls[0]
  assert.deepEqual(Object.keys(args).sort(), ['action', 'explicitAction', 'freshnessCheck', 'now', 'snapshotPath', 'storePath', 'targetIds', 'trigger', 'valueKey'])
  assert.equal(args.action, realRepairService.REPAIR_ACTION)
  assert.equal(args.trigger, 'owner-action')
  assert.equal(args.explicitAction, true)
  assert.deepEqual(args.targetIds, ['node-a2', 'node-a1'])
  assert.equal(args.valueKey, TREE_KEY)
  assert.equal(args.now instanceof Date, true)
  assert.equal(typeof args.freshnessCheck, 'function')
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'plan', 'preview', 'previewToken'])
  assert.equal(result.plan.sourceSha256, sha(h.f.disk()))
})

test('the freshness check answers exactly true only for a settled, agreeing store and the file and bytes the service is working on', async t => {
  const h = harness(t)
  await h.adapter.nodeStatusRepairPreview({}, person)
  const check = h.repair.calls[0].args.freshnessCheck
  const source = h.f.disk()
  // A staged replacement is checked too, so a status-only wrapper is what a well-behaved service would actually stage.
  const statusOnly = wrapperOf({ ...h.f.values, [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'finished'], ['node-a2', 'finished']]) })
  const phases = [{ phase: 'backup', storePath: h.f.fleetFile }, { phase: 'stage', storePath: h.f.fleetFile, expectedText: source, sourceSha256: sha(source), replacementText: statusOnly },
    { phase: 'commit', storePath: h.f.fleetFile, expectedText: source, sourceSha256: sha(source), replacementText: statusOnly }]
  for (const payload of phases) assert.equal(check(payload), true, payload.phase)
  assert.equal(check({ storePath: h.f.fleetFile, replacementText: 'not even a wrapper' }), false, 'a staged replacement that is not status-only is refused too')
  assert.equal(check.lastRefusal().code, CODES.REPLACEMENT_NOT_STATUS_ONLY)
  assert.equal(check(), true)
  assert.equal(check({ storePath: '/elsewhere/renderer-fleet-documents.json' }), false)
  assert.equal(check({ storePath: h.f.fleetFile, expectedText: `${source} ` }), false)
  assert.equal(check({ storePath: h.f.fleetFile, sourceSha256: sha('another store') }), false)
  assert.equal(check.lastRefusal().code, CODES.CHANGED)
  // The store stops being settled, or stops agreeing.
  h.f.prefs.set(TREE_KEY, treeDocument('this-computer', [['node-a1']]), { expectedValue: h.f.values[TREE_KEY] })
  assert.equal(check({ phase: 'backup' }), false)
  assert.equal(check.lastRefusal().code, CODES.PENDING)
  await h.f.prefs.flushFleetDocuments()
  assert.equal(check({ phase: 'backup' }), true)
  h.f.files.set(h.f.fleetFile, wrapperOf({ ...baseValues(), [DIFF_KEY]: 'written by someone else' }))
  assert.equal(check({ phase: 'backup' }), false)
  assert.equal(check.lastRefusal().code, CODES.DISAGREES)
})

test('a store that changes while the service is preparing is refused with the gate that refused it, and no preview is kept', async t => {
  const h = harness(t, { hooks: { beforeFreshness: () => { h.f.prefs.set(TREE_KEY, treeDocument('this-computer', [['node-a1']]), { expectedValue: h.f.values[TREE_KEY] }) } } })
  const result = await h.adapter.nodeStatusRepairPreview({}, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FRESHNESS_REFUSED')
  assert.equal(result.fleetGate.code, CODES.PENDING)
  const late = await h.adapter.nodeStatusRepairConfirm({ previewToken: 'preview-1' }, person)
  assert.equal(late.code, 'PREVIEW_MISSING')
})

test('a preview built from bytes other than the store that was checked is refused and cannot be confirmed', async t => {
  const h = harness(t, { hooks: { sourceSha256: sha('some other store') } })
  const result = await h.adapter.nodeStatusRepairPreview({}, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.CHANGED)
  assert.equal((await h.adapter.nodeStatusRepairConfirm({ previewToken: 'preview-1' }, person)).code, 'PREVIEW_MISSING')
  assert.equal(h.repair.calls.some(call => call.method === 'confirmRepair'), false)
})

test('repair confirm needs the preview token this adapter issued, once, and the reviewed store unchanged', async t => {
  const h = harness(t)
  const reviewed = await h.adapter.nodeStatusRepairPreview({}, person)
  for (const previewToken of [undefined, '', 5, 'x'.repeat(600), 'unknown']) {
    assert.equal((await h.adapter.nodeStatusRepairConfirm({ previewToken }, person)).code, 'PREVIEW_MISSING', String(previewToken))
  }
  assert.equal(h.repair.calls.some(call => call.method === 'confirmRepair'), false)
  await editTrees(h.f, [['node-a1'], ['node-a2', 'finished'], ['node-a5']])
  const changed = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(changed.code, CODES.CHANGED)
  assert.equal(h.repair.calls.some(call => call.method === 'confirmRepair'), false)
  assert.equal(h.state.dialogs.length, 0)
})

test('an approved repair commits through the renderer-prefs seam, bytes and cache together, and is reported confirmed with the fleet-tree keys it actually changed', async t => {
  const commits = []
  const h = harness(t, { hooks: { commitCalls: commits } })
  const reviewed = await h.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const before = h.f.disk()
  const result = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.deepEqual(result, {
    ok: true, confirmed: true, changedKeys: [TREE_KEY], postWriteVerified: true, planHash: 'a'.repeat(64),
    backupPath: reviewed.plan.backupPath, restoredNodeIds: reviewed.plan.changes.map(change => change.nodeId),
    changes: reviewed.plan.changes, skipped: [], seatChanges: [], notRestorableSeats: [], postWriteSha256: sha(h.repair.replacement()),
  })
  assert.deepEqual(commits, [{ ok: true }])
  assert.notEqual(h.f.disk(), before)
  assert.equal(h.f.disk(), h.repair.replacement())
  assert.equal(h.f.prefs.snapshot().values[TREE_KEY], h.repair.repairedDocument)
  assert.equal(h.f.prefs.snapshot().fleetPending, false)
  assert.equal(stored(h.f).ok, true, 'the repaired store agrees with the cache and can be maintained again')
  assert.equal(stored(h.f).sha256, sha(h.f.disk()))
  const confirmCall = h.repair.calls.find(call => call.method === 'confirmRepair')
  assert.deepEqual(Object.keys(confirmCall.args).sort(), ['commitReplacement', 'confirmNative', 'freshnessCheck', 'now', 'previewToken'])
  assert.equal(h.state.dialogs.length, 1)
  assert.equal((await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)).code, 'PREVIEW_MISSING')
  assert.equal(h.repair.calls.filter(call => call.method === 'confirmRepair').length, 1, 'the second confirmation was refused before it reached the service')
})

test('a commit the seam refuses is reported as refused, and neither the durable bytes nor the cache change', async t => {
  const h = harness(t)
  const reviewed = await h.adapter.nodeStatusRepairPreview({}, person)
  const before = h.f.disk()
  // Staging the replacement fails inside the seam after the person approved: every earlier check had passed.
  h.state.onDialog = () => { h.f.fail.open = 'EIO' }
  const result = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_FLEET_MAINTENANCE_WRITE_FAILED')
  assert.equal(h.f.disk(), before)
  assert.notEqual(h.f.prefs.snapshot().values[TREE_KEY], h.repair.repairedDocument)
  assert.equal(h.f.prefs.snapshot().fleetPending, false)
})

test('the native repair dialog decides: cancelling, a headless run and a store that changed while it was open repair nothing', async t => {
  const cancelled = harness(t, { answer: 0 })
  const reviewed = await cancelled.adapter.nodeStatusRepairPreview({}, person)
  const before = cancelled.f.disk()
  const refused = await cancelled.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(refused.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(cancelled.f.disk(), before)

  process.env.MC_SMOKE_HEADLESS = '1'
  try {
    const headless = harness(t)
    const review = await headless.adapter.nodeStatusRepairPreview({}, person)
    assert.equal((await headless.adapter.nodeStatusRepairConfirm({ previewToken: review.previewToken }, person)).code, 'NATIVE_CONFIRM_REFUSED')
    assert.equal(headless.state.dialogs.length, 0)
  } finally { delete process.env.MC_SMOKE_HEADLESS }

  const moving = harness(t)
  const review = await moving.adapter.nodeStatusRepairPreview({}, person)
  moving.state.onDialog = () => editTrees(moving.f, [['node-a1'], ['node-a2', 'finished'], ['node-a7']])
  const result = await moving.adapter.nodeStatusRepairConfirm({ previewToken: review.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(result.fleetGate.code, CODES.CHANGED)
  assert.equal(moving.repair.calls.filter(call => call.method === 'confirmRepair').length, 1)
  assert.notEqual(moving.f.prefs.snapshot().values[TREE_KEY], moving.repair.repairedDocument)
})

test('a service that fails, throws or answers with anything but success is never reported as a repair', async t => {
  const garbage = [undefined, null, 'done', 42, {}, { ok: 'yes' }, { ok: true }, { ok: false }]
  for (const prepareResult of garbage) {
    const h = harness(t, { hooks: { prepareResult } })
    const result = await h.adapter.nodeStatusRepairPreview({}, person)
    assert.equal(result.ok, false, JSON.stringify(prepareResult))
    assert.equal(result.code === undefined, false, JSON.stringify(prepareResult))
  }
  const thrown = harness(t, { hooks: { prepareError: new Error('ENOENT: no such file /home/redacted-profile/private/renderer-fleet-documents.json') } })
  const failedPrepare = await thrown.adapter.nodeStatusRepairPreview({}, person)
  assert.deepEqual([failedPrepare.ok, failedPrepare.code], [false, 'AGENT_NODE_STATUS_REPAIR_FAILED'])
  assert.doesNotMatch(JSON.stringify(failedPrepare), /someone|private|ENOENT/)
  const throwing = harness(t, { hooks: { confirmError: new Error('boom at /home/redacted-profile/private') } })
  const review = await throwing.adapter.nodeStatusRepairPreview({}, person)
  const failedConfirm = await throwing.adapter.nodeStatusRepairConfirm({ previewToken: review.previewToken }, person)
  assert.deepEqual([failedConfirm.ok, failedConfirm.code], [false, 'AGENT_NODE_STATUS_REPAIR_FAILED'])
  assert.doesNotMatch(JSON.stringify(failedConfirm), /someone|private|boom/)
  // (A bare `{ ok: true }` is the service's own word for success and is passed on as it is; the rest is not success.)
  for (const confirmResult of garbage.filter(item => item?.ok !== true)) {
    const h = harness(t, { hooks: { confirmResult } })
    const reviewed = await h.adapter.nodeStatusRepairPreview({}, person)
    assert.equal(reviewed.ok, true)
    const result = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
    assert.equal(result.ok, false, JSON.stringify(confirmResult))
    assert.equal(typeof result.code, 'string', JSON.stringify(confirmResult))
  }
  // A failure the service reports keeps its own code and words.
  const refused = harness(t, { hooks: { confirmResult: { ok: false, code: 'PREVIEW_STALE', reason: 'The current store changed after the owner preview.' } } })
  const review2 = await refused.adapter.nodeStatusRepairPreview({}, person)
  const reported = await refused.adapter.nodeStatusRepairConfirm({ previewToken: review2.previewToken }, person)
  assert.deepEqual(reported, { ok: false, code: 'PREVIEW_STALE', reason: 'The current store changed after the owner preview.' })
})

test('a change after the repair confirmation started and before its dialog shows the person nothing', async t => {
  const h = harness(t, { hooks: { beforeNative: () => editTrees(h.f, [['node-a1'], ['node-a2', 'finished'], ['node-a10']]) } })
  const reviewed = await h.adapter.nodeStatusRepairPreview({}, person)
  const result = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(result.fleetGate.code, CODES.CHANGED)
  assert.equal(h.state.dialogs.length, 0)
  assert.notEqual(h.f.prefs.snapshot().values[TREE_KEY], h.repair.repairedDocument)
})

test('the real guarded snapshot service accepts the adapter\'s call, and its plan is built from the very bytes the adapter hashed', async t => {
  // (A multi-byte character in the store: the adapter hashes bytes, the service hashes text, and the two must be the same hash.)
  const current = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1', statusNote: 'refusé-1' }]])
  const snapshot = treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1', statusNote: 'finished-1' }]])
  const values = { [TREE_KEY]: current, [DIFF_KEY]: 'unrelated chat diff bytes' }
  const h = harness(t, { fixtureOptions: { values } })
  const snapshotFile = path.join(h.f.directory, 'saved-snapshot.json')
  h.f.files.set(snapshotFile, wrapperOf({ ...values, [TREE_KEY]: snapshot }))
  const files = h.f.files
  const memory = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(file) },
    async stat(file) { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { size: Buffer.byteLength(files.get(file)), mtimeMs: 1 } },
    async mkdir() {},
    async copyFile(from, to) { if (files.has(to)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); files.set(to, files.get(from)) },
    async writeFile(file, text) { files.set(file, text) },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from) },
    async open() { return { async sync() {}, async close() {} } },
  }
  const phases = []
  const repairService = { ...realRepairService, prepareRepair: args => realRepairService.prepareRepair({ ...args, fs: memory, freshnessCheck: payload => { phases.push(payload.phase); return args.freshnessCheck(payload) } }) }
  const adapter = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: h.engine.requireModule, dialog: null, chooseSnapshotFile: async () => snapshotFile,
    repairService, rendererPrefs: h.f.prefs, fleetStorePath: h.f.fleetFile, fs: h.f.fs })
  const result = await adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'], valueKey: TREE_KEY }, person)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(phases, ['backup'])
  assert.equal(result.plan.sourceSha256, stored(h.f).sha256)
  assert.equal(result.plan.sourceSha256, sha(h.f.disk()))
  assert.deepEqual(result.plan.changes.map(change => [change.nodeId, change.status.from, change.status.to]), [['node-a1', 'turn-failed', 'finished']])
  assert.equal(files.get(result.plan.backupPath), h.f.disk(), 'the dated copy is the store as it was')
  // The store stops agreeing with its cache: the real service is refused by the adapter's check, before it copies anything.
  const files2 = new Set(files.keys())
  files.set(h.f.fleetFile, wrapperOf({ ...values, [DIFF_KEY]: 'written by someone else' }))
  const refused = await adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'], valueKey: TREE_KEY }, person)
  assert.equal(refused.code, CODES.DISAGREES)
  assert.deepEqual([...files.keys()].filter(file => !files2.has(file)), [], 'no copy was made')
})

test('the repair dialog names the dated copy, defaults to Cancel and is approved only by its second button', async () => {
  let spec = null
  const dialog = { showMessageBox: async (window, options) => { spec = options; return { response: 1 } } }
  const payload = { changes: [{ nodeId: 'node-a1' }, { nodeId: 'node-a2' }], skipped: [{ nodeId: 'node-a3' }], backupPath: '/x/renderer-fleet-documents.json.repair-backup-y.json' }
  assert.equal(await createNativeRepairConfirmOwner({ dialog })(payload), true)
  assert.match(spec.detail, /repair-backup-y\.json/)
  assert.match(spec.detail, /1 more agent was left unchanged/)
  assert.match(spec.buttons[1], /Restore 2 agents/)
  assert.doesNotMatch(spec.detail, /cannot be undone/i)
  assert.deepEqual([spec.buttons[0], spec.cancelId, spec.defaultId], ['Cancel', 0, 0])
  for (const answer of [{ response: 0 }, { response: 2 }, { response: '1' }, {}, undefined, null]) {
    assert.notEqual(await createNativeRepairConfirmOwner({ dialog: { showMessageBox: async () => answer } })(payload), true, JSON.stringify(answer))
  }
  for (const empty of [{}, { changes: [], backupPath: 'x' }, { changes: [{}] }, undefined]) assert.equal(await createNativeRepairConfirmOwner({ dialog })(empty), false)
  assert.equal(await createNativeRepairConfirmOwner({ dialog: null })(payload), false)
})

// ---- the status-only comparison rollback and repair both rest on ----

const mapOf = values => new Map(Object.entries(values))

test('statusOnlyDiff finds exactly a status-only change, and refuses everything else by name', () => {
  const original = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished']])
  const base = mapOf({ [TREE_KEY]: original, [DIFF_KEY]: 'unrelated chat diff bytes' })

  const statusOnly = treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1', statusNote: 'restored' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: statusOnly, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: true, changedKeys: [TREE_KEY], changedNodes: 1 })

  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: original, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: true, changedKeys: [], changedNodes: 0 }, 'nothing to restore is ok with nothing changed')

  const olderSession = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's0', lastTurnId: 't1' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: olderSession, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'identity' }, 'a different session')

  const olderTurn = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't0' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: olderTurn, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'identity' }, 'a different turn')

  const olderCreated = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1', createdAt: '2020-01-01T00:00:00.000Z' }], ['node-a2', 'finished']])
  const laterCreated = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1', createdAt: '2021-01-01T00:00:00.000Z' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(mapOf({ [TREE_KEY]: olderCreated, [DIFF_KEY]: 'unrelated chat diff bytes' }), mapOf({ [TREE_KEY]: laterCreated, [DIFF_KEY]: 'unrelated chat diff bytes' })),
    { ok: false, kind: 'identity' }, 'a different createdAt')

  const otherField = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1', priority: 'high' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: otherField, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'a field that is neither status nor identity')

  const addedNode = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished'], ['node-a3']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: addedNode, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'a node added or removed')

  const otherComputer = treeDocument('other-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: otherComputer, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'the tree itself differs')

  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: original, [DIFF_KEY]: 'written by someone else' })), { ok: false, kind: 'other' }, 'a non-tree document differs')

  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: original })), { ok: false, kind: 'other' }, 'a document is missing entirely')

  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: original.slice(0, -1), [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'a tree document that is not even JSON')

  // A changed node's status is bound to the guarded repair's own scope (finished<->turn-failed) on both sides; an
  // unrelated status this module was never asked to touch, like running or draft, is not a status-only change here
  // even though only the status field itself differs -- but a node whose status stays running, untouched, is fine.
  const movedOutOfScope = treeDocument('this-computer', [['node-a1', 'running', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished']])
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: movedOutOfScope, [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'the new status is outside finished/turn-failed')
  const alreadyRunning = treeDocument('this-computer', [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'running']])
  const stillRunningButFinished = treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'running']])
  assert.deepEqual(statusOnlyDiff(mapOf({ [TREE_KEY]: alreadyRunning, [DIFF_KEY]: 'unrelated chat diff bytes' }), mapOf({ [TREE_KEY]: stillRunningButFinished, [DIFF_KEY]: 'unrelated chat diff bytes' })),
    { ok: true, changedKeys: [TREE_KEY], changedNodes: 1 }, 'an untouched node may hold any status; only the changed one is bound')

  // Nodes aligned by id and treeId can still differ: the document's own fields (version, computerId, the trees list)
  // are compared too, independently of any per-node field.
  const otherVersion = JSON.parse(original)
  otherVersion.version = 2
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: JSON.stringify(otherVersion), [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'the document version differs, nodes otherwise identical')
  const otherComputerId = JSON.parse(original)
  otherComputerId.computerId = 'renamed-computer'
  assert.deepEqual(statusOnlyDiff(base, mapOf({ [TREE_KEY]: JSON.stringify(otherComputerId), [DIFF_KEY]: 'unrelated chat diff bytes' })), { ok: false, kind: 'other' }, 'the computer id differs, nodes otherwise identical')

  // A side with MORE documents than the other is refused even where every document the smaller side does hold matches
  // exactly (the size check, not only the per-key presence check, catches this).
  assert.deepEqual(statusOnlyDiff(mapOf({ [TREE_KEY]: original }), mapOf({ [TREE_KEY]: original, [DIFF_KEY]: 'present only on the other side' })), { ok: false, kind: 'other' }, 'the other side holds an extra document')
})

// ---- node status rollback, on the same guarded snapshot service ----

const IDENTITY_NODES = [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]]
const identityValues = (nodes = IDENTITY_NODES) => ({ [TREE_KEY]: treeDocument('this-computer', nodes), [DIFF_KEY]: 'unrelated chat diff bytes' })

test('rollback is unavailable, by name, without the service or the native picker', async t => {
  const h = harness(t)
  const bare = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: h.engine.requireModule, dialog: null,
    rendererPrefs: h.f.prefs, fleetStorePath: h.f.fleetFile, fs: h.f.fs, repairService: h.repair.service })
  const unusable = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: h.engine.requireModule, dialog: null,
    rendererPrefs: h.f.prefs, fleetStorePath: h.f.fleetFile, fs: h.f.fs, repairService: {}, chooseRollbackFile: async () => backupOf(h, { nodes: [['node-a1']] }) })
  assert.equal((await bare.nodeStatusRollbackPreview({}, person)).code, 'AGENT_NODE_STATUS_ROLLBACK_UNAVAILABLE')
  assert.equal((await unusable.nodeStatusRollbackPreview({}, person)).code, 'AGENT_NODE_STATUS_ROLLBACK_UNAVAILABLE')
  assert.equal((await unusable.nodeStatusRollbackConfirm({ previewToken: 'token' }, person)).code, 'AGENT_NODE_STATUS_ROLLBACK_UNAVAILABLE')
  assert.deepEqual(h.repair.calls, [])
  // With both, it is available.
  const ready = harness(t)
  ready.state.backup = backupOf(ready, { nodes: [['node-a1', 'finished'], ['node-a2', 'turn-failed']] })
  assert.equal((await ready.adapter.nodeStatusRollbackPreview({}, person)).ok, true)
})

test('the rollback backup is chosen only by the native picker; a missing, relative or undated choice, or the store path itself, is refused before it is read', async t => {
  for (const chosen of [null, undefined, '', 'relative/backup.repair-backup-x.json', 42]) {
    const h = harness(t)
    h.state.backup = chosen
    const result = await h.adapter.nodeStatusRollbackPreview({}, person)
    assert.equal(result.code, CODES.BACKUP_NOT_CHOSEN, String(chosen))
    assert.equal(h.state.rollbackPickers, 1, String(chosen))
    assert.deepEqual(h.repair.calls, [], String(chosen))
    assert.equal(h.state.dialogs.length, 0, String(chosen))
  }
  const broken = harness(t)
  broken.state.rollbackPickerError = new Error('picker failed')
  assert.equal((await broken.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.BACKUP_NOT_CHOSEN)
  assert.deepEqual(broken.repair.calls, [])
  const storeItself = harness(t)
  storeItself.state.backup = storeItself.f.fleetFile
  assert.equal((await storeItself.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.BACKUP_NOT_DATED)
  const undated = harness(t)
  undated.state.backup = path.join(undated.f.directory, 'renderer-fleet-documents.json.bak')
  undated.f.files.set(undated.state.backup, wrapperOf(undated.f.values))
  assert.equal((await undated.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.BACKUP_NOT_DATED)
  assert.deepEqual(storeItself.repair.calls, [])
  assert.deepEqual(undated.repair.calls, [])
})

test('a chosen backup that cannot be read, or is not a saved-trees wrapper this version reads, is refused before any comparison', async t => {
  const missing = harness(t)
  missing.state.backup = `${missing.f.fleetFile}.repair-backup-20260921T190000Z-fedcba9876543210.json`
  assert.equal((await missing.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.BACKUP_UNREADABLE)

  const garbled = harness(t)
  garbled.state.backup = backupOf(garbled, { text: 'not json at all' })
  assert.equal((await garbled.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.BACKUP_UNREADABLE)

  const wrongVersion = harness(t)
  wrongVersion.state.backup = backupOf(wrongVersion, { text: `${JSON.stringify({ storageVersion: 2, values: wrongVersion.f.values })}\n` })
  assert.equal((await wrongVersion.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.BACKUP_UNREADABLE)

  for (const h of [missing, garbled, wrongVersion]) assert.deepEqual(h.repair.calls, [])
})

test('a backup that differs from the saved trees in more than status is refused, by name, before a safety copy is made', async t => {
  const otherField = harness(t, { fixtureOptions: { values: identityValues() } })
  otherField.state.backup = backupOf(otherField, { nodes: [['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1', priority: 'high' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  assert.equal((await otherField.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.ROLLBACK_NOT_STATUS_ONLY)

  const addedNode = harness(t, { fixtureOptions: { values: identityValues() } })
  addedNode.state.backup = backupOf(addedNode, { nodes: [...IDENTITY_NODES, ['node-a9', 'finished']] })
  assert.equal((await addedNode.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.ROLLBACK_NOT_STATUS_ONLY)

  const changedSession = harness(t, { fixtureOptions: { values: identityValues() } })
  changedSession.state.backup = backupOf(changedSession, { nodes: [['node-a1', 'finished', { sessionId: 's2', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  assert.equal((await changedSession.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.ROLLBACK_IDENTITY_DIFFERS)

  const changedTurn = harness(t, { fixtureOptions: { values: identityValues() } })
  changedTurn.state.backup = backupOf(changedTurn, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't2' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  assert.equal((await changedTurn.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.ROLLBACK_IDENTITY_DIFFERS)

  // A backup that would put a node's status back to something outside the guarded repair's own scope -- here
  // running, which the live tree refresh does not expect a repair or rollback to ever produce -- is refused the
  // same way, even though status is the only field that differs.
  const outOfScope = harness(t, { fixtureOptions: { values: identityValues() } })
  outOfScope.state.backup = backupOf(outOfScope, { nodes: [['node-a1', 'running', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  assert.equal((await outOfScope.adapter.nodeStatusRollbackPreview({}, person)).code, CODES.ROLLBACK_NOT_STATUS_ONLY)

  for (const h of [otherField, addedNode, changedSession, changedTurn, outOfScope]) {
    assert.deepEqual(h.repair.calls, [])
    assert.equal(h.state.dialogs.length, 0)
  }
})

test('a backup identical to the saved trees has nothing to put back', async t => {
  const h = harness(t, { fixtureOptions: { values: identityValues() } })
  h.state.backup = backupOf(h, { values: identityValues() })
  const result = await h.adapter.nodeStatusRollbackPreview({}, person)
  assert.equal(result.code, CODES.ROLLBACK_NOTHING_TO_RESTORE)
  assert.deepEqual(h.repair.calls, [])
})

test('an approved rollback puts back exactly the status a dated backup differs by, commits through the renderer-prefs seam, and is reported confirmed with the fleet-tree keys it changed', async t => {
  const h = harness(t, { fixtureOptions: { values: identityValues() } })
  const restoredDocument = treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1', statusNote: 'put back' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]])
  h.state.backup = backupOf(h, { values: { ...identityValues(), [TREE_KEY]: restoredDocument } })
  const reviewed = await h.adapter.nodeStatusRollbackPreview({}, person)
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed))
  assert.deepEqual(reviewed.changedKeys, [TREE_KEY])
  const before = h.f.disk()
  const result = await h.adapter.nodeStatusRollbackConfirm({ previewToken: reviewed.previewToken }, person)
  assert.deepEqual(result, { ok: true, confirmed: true, changedKeys: [TREE_KEY], postWriteVerified: true, planHash: 'b'.repeat(64),
    restorePath: h.state.backup, safetyBackupPath: h.repair.safetyBackupPath, postWriteSha256: sha(h.f.disk()) })
  assert.notEqual(h.f.disk(), before)
  assert.equal(h.f.prefs.snapshot().values[TREE_KEY], restoredDocument)
  assert.equal(h.f.prefs.snapshot().fleetPending, false)
  assert.equal(stored(h.f).ok, true, 'the restored store agrees with the cache and can be maintained again')
  assert.equal(stored(h.f).sha256, sha(h.f.disk()))
  const confirmCall = h.repair.calls.find(call => call.method === 'confirmRollback')
  assert.deepEqual(Object.keys(confirmCall.args).sort(), ['action', 'commitReplacement', 'confirmNative', 'explicitAction', 'freshnessCheck', 'now', 'previewToken', 'trigger'])
  assert.equal(h.state.dialogs.length, 1)
  assert.equal((await h.adapter.nodeStatusRollbackConfirm({ previewToken: reviewed.previewToken }, person)).code, 'PREVIEW_MISSING')
  assert.equal(h.repair.calls.filter(call => call.method === 'confirmRollback').length, 1, 'the second confirmation was refused before it reached the service')
})

test('rollback confirm needs the reviewed store, and the reviewed backup exactly, unchanged; the seam is never asked over anything else', async t => {
  const h = harness(t, { fixtureOptions: { values: identityValues() } })
  h.state.backup = backupOf(h, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  const reviewed = await h.adapter.nodeStatusRollbackPreview({}, person)
  assert.equal(reviewed.ok, true)
  for (const previewToken of [undefined, '', 5, 'x'.repeat(600), 'unknown']) {
    assert.equal((await h.adapter.nodeStatusRollbackConfirm({ previewToken }, person)).code, 'PREVIEW_MISSING', String(previewToken))
  }
  assert.equal(h.repair.calls.some(call => call.method === 'confirmRollback'), false)

  // The store moved after the preview.
  const storeMoved = harness(t, { fixtureOptions: { values: identityValues() } })
  storeMoved.state.backup = backupOf(storeMoved, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  const storeMovedReview = await storeMoved.adapter.nodeStatusRollbackPreview({}, person)
  await editTrees(storeMoved.f, [['node-a1', 'running', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]])
  const afterStoreMoved = await storeMoved.adapter.nodeStatusRollbackConfirm({ previewToken: storeMovedReview.previewToken }, person)
  assert.equal(afterStoreMoved.code, CODES.CHANGED)
  assert.equal(storeMoved.repair.calls.some(call => call.method === 'confirmRollback'), false)
  assert.equal(storeMoved.state.dialogs.length, 0)

  // The backup itself was rewritten after the preview -- with older words, and with a changed identity -- both refused before the service is asked.
  for (const rewrite of [
    [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1', priority: 'high' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]],
    [['node-a1', 'finished', { sessionId: 's2', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]],
  ]) {
    const moving = harness(t, { fixtureOptions: { values: identityValues() } })
    moving.state.backup = backupOf(moving, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
    const movingReview = await moving.adapter.nodeStatusRollbackPreview({}, person)
    moving.f.files.set(moving.state.backup, wrapperOf({ ...identityValues(), [TREE_KEY]: treeDocument('this-computer', rewrite) }))
    const afterRewrite = await moving.adapter.nodeStatusRollbackConfirm({ previewToken: movingReview.previewToken }, person)
    assert.equal(afterRewrite.code, CODES.CHANGED, JSON.stringify(rewrite))
    assert.equal(moving.repair.calls.some(call => call.method === 'confirmRollback'), false, JSON.stringify(rewrite))
  }
})

test('a replacement the service is about to commit that does not match the exact backup the person reviewed is refused before it reaches the seam', async t => {
  const other = treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1', statusNote: 'a different restore' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]])
  const h = harness(t, { fixtureOptions: { values: identityValues() }, hooks: { rollbackReplacement: wrapperOf({ ...identityValues(), [TREE_KEY]: other }) } })
  h.state.backup = backupOf(h, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  const reviewed = await h.adapter.nodeStatusRollbackPreview({}, person)
  const before = h.f.disk()
  const result = await h.adapter.nodeStatusRollbackConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FRESHNESS_REFUSED')
  assert.equal(result.fleetGate.code, CODES.CHANGED)
  assert.equal(h.f.disk(), before)
})

test('a change after the rollback confirmation started and before its dialog shows the person nothing', async t => {
  const h = harness(t, { fixtureOptions: { values: identityValues() },
    hooks: { beforeNative: () => editTrees(h.f, [['node-a1', 'running', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]]) } })
  h.state.backup = backupOf(h, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  const reviewed = await h.adapter.nodeStatusRollbackPreview({}, person)
  const result = await h.adapter.nodeStatusRollbackConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(result.fleetGate.code, CODES.CHANGED)
  assert.equal(h.state.dialogs.length, 0, 'a store that already moved is never shown to the person as if it were current')
})

test('the native rollback dialog decides: cancelling, a headless run and a store that changed while it was open put nothing back', async t => {
  const cancelled = harness(t, { fixtureOptions: { values: identityValues() }, answer: 0 })
  cancelled.state.backup = backupOf(cancelled, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  const reviewed = await cancelled.adapter.nodeStatusRollbackPreview({}, person)
  const before = cancelled.f.disk()
  const refused = await cancelled.adapter.nodeStatusRollbackConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(refused.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(cancelled.f.disk(), before)

  process.env.MC_SMOKE_HEADLESS = '1'
  try {
    const headless = harness(t, { fixtureOptions: { values: identityValues() } })
    headless.state.backup = backupOf(headless, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
    const review = await headless.adapter.nodeStatusRollbackPreview({}, person)
    assert.equal((await headless.adapter.nodeStatusRollbackConfirm({ previewToken: review.previewToken }, person)).code, 'NATIVE_CONFIRM_REFUSED')
    assert.equal(headless.state.dialogs.length, 0)
  } finally { delete process.env.MC_SMOKE_HEADLESS }

  const moving = harness(t, { fixtureOptions: { values: identityValues() } })
  moving.state.backup = backupOf(moving, { nodes: [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]] })
  const review = await moving.adapter.nodeStatusRollbackPreview({}, person)
  moving.state.onDialog = () => editTrees(moving.f, [['node-a1', 'running', { sessionId: 's1', lastTurnId: 't1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]])
  const result = await moving.adapter.nodeStatusRollbackConfirm({ previewToken: review.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(result.fleetGate.code, CODES.CHANGED)
  assert.equal(moving.repair.calls.filter(call => call.method === 'confirmRollback').length, 1)
})

test('the real guarded rollback service accepts the adapter\'s call, its safety backup is the store as it was, and its plan is built from the very bytes both sides hashed', async t => {
  // (The same multi-byte proof as the repair test: the adapter hashes bytes, the service hashes text, and the two must agree.)
  const values = identityValues([['node-a1', 'turn-failed', { sessionId: 's1', lastTurnId: 't1', statusNote: 'refusé-1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]])
  const h = harness(t, { fixtureOptions: { values } })
  const restoreDocument = treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 's1', lastTurnId: 't1', statusNote: 'restauré-1' }], ['node-a2', 'finished', { sessionId: 's1', lastTurnId: 't1' }]])
  const restoreWrapperText = wrapperOf({ ...values, [TREE_KEY]: restoreDocument })
  const restorePath = backupOf(h, { text: restoreWrapperText })
  h.state.backup = restorePath
  const files = h.f.files
  const memory = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(file) },
    async stat(file) { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { size: Buffer.byteLength(files.get(file)), mtimeMs: 1 } },
    async mkdir() {},
    async copyFile(from, to) { if (files.has(to)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); files.set(to, files.get(from)) },
    async writeFile(file, text) { files.set(file, text) },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from) },
    async open() { return { async sync() {}, async close() {} } },
  }
  const phases = []
  const before = h.f.disk()
  const rollbackService = { ...realRepairService, prepareRollback: args => realRepairService.prepareRollback({ ...args, fs: memory, freshnessCheck: payload => { phases.push(payload.phase); return args.freshnessCheck(payload) } }) }
  const adapter = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: h.engine.requireModule, dialog: null, chooseRollbackFile: async () => restorePath,
    repairService: rollbackService, rendererPrefs: h.f.prefs, fleetStorePath: h.f.fleetFile, fs: h.f.fs })
  const result = await adapter.nodeStatusRollbackPreview({}, person)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(phases, ['safety-backup'])
  assert.equal(result.plan.source.sha256, stored(h.f).sha256)
  assert.equal(result.plan.source.sha256, sha(h.f.disk()))
  assert.equal(result.plan.restore.sha256, sha(restoreWrapperText))
  assert.equal(files.get(result.plan.safetyBackupPath), before, 'the safety copy is the store exactly as it was, before anything changed')
  assert.equal(h.f.disk(), before, 'the preview alone changes nothing but the safety copy')
  // The store stops agreeing with its cache: the real service is refused by the adapter's check, before it copies anything.
  const filesBefore = new Set(files.keys())
  files.set(h.f.fleetFile, wrapperOf({ ...values, [DIFF_KEY]: 'written by someone else' }))
  const refused = await adapter.nodeStatusRollbackPreview({}, person)
  assert.equal(refused.code, CODES.DISAGREES)
  assert.deepEqual([...files.keys()].filter(file => !filesBefore.has(file)), [], 'no safety copy was made')
})

test('the rollback dialog names the safety copy as the way back, defaults to Cancel, is approved only by its second button, and is never asked with nothing to put back', async () => {
  let spec = null
  const dialog = { showMessageBox: async (window, options) => { spec = options; return { response: 1 } } }
  const payload = { safetyBackupPath: '/x/renderer-fleet-documents.json.repair-backup-y.json' }
  assert.equal(await createNativeRollbackConfirmOwner({ dialog, nodes: 2 })(payload), true)
  assert.match(spec.detail, /repair-backup-y\.json/)
  assert.match(spec.detail, /Nothing but agent status is put back/)
  assert.match(spec.buttons[1], /Put back 2 agents/)
  assert.deepEqual([spec.buttons[0], spec.cancelId, spec.defaultId], ['Cancel', 0, 0])
  await createNativeRollbackConfirmOwner({ dialog, nodes: 1 })(payload)
  assert.match(spec.buttons[1], /Put back 1 agent$/)
  for (const answer of [{ response: 0 }, { response: 2 }, { response: '1' }, {}, undefined, null]) {
    assert.notEqual(await createNativeRollbackConfirmOwner({ dialog: { showMessageBox: async () => answer }, nodes: 2 })(payload), true, JSON.stringify(answer))
  }
  assert.equal(await createNativeRollbackConfirmOwner({ dialog, nodes: 0 })(payload), false, 'nothing to put back is never asked')
  assert.equal(await createNativeRollbackConfirmOwner({ dialog, nodes: 2 })({}), false, 'no safety backup path is never asked')
  assert.equal(await createNativeRollbackConfirmOwner({ dialog: null, nodes: 2 })(payload), false)
  process.env.MC_SMOKE_HEADLESS = '1'
  try { assert.equal(await createNativeRollbackConfirmOwner({ dialog, nodes: 2 })(payload), false) } finally { delete process.env.MC_SMOKE_HEADLESS }
})

// ---- what a repair or rollback is reported as, and what it is never taken on trust for ----

test('a status reported ok is never taken on trust: the approval, the verification, the hash and the diff must each be real, or the change is not reported', async t => {
  // The real guarded service always asks confirmNative and always asks its own freshnessCheck before it commits; these
  // are synthetic ways a reported "ok" could be hollow, to prove this module checks for itself rather than trusting the word.
  const skippedNative = harness(t, { hooks: { skipNative: true } })
  const skippedReview = await skippedNative.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const skippedResult = await skippedNative.adapter.nodeStatusRepairConfirm({ previewToken: skippedReview.previewToken }, person)
  assert.deepEqual([skippedResult.ok, skippedResult.code], [false, CODES.UNVERIFIED], 'the service committed without ever asking the native dialog this module tracks approval through')

  const unverified = harness(t, { hooks: { postWriteVerified: false } })
  const unverifiedReview = await unverified.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const unverifiedResult = await unverified.adapter.nodeStatusRepairConfirm({ previewToken: unverifiedReview.previewToken }, person)
  assert.deepEqual([unverifiedResult.ok, unverifiedResult.code], [false, CODES.UNVERIFIED], 'the service itself did not report the write verified')

  const wrongSha = harness(t, { hooks: { postWriteSha256: 'f'.repeat(64) } })
  const wrongShaReview = await wrongSha.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const wrongShaResult = await wrongSha.adapter.nodeStatusRepairConfirm({ previewToken: wrongShaReview.previewToken }, person)
  assert.deepEqual([wrongShaResult.ok, wrongShaResult.code], [false, CODES.UNVERIFIED], 'the reported hash does not match what is actually on disk')

  const wrongValueKey = harness(t, { hooks: { changes: [{ valueKey: DIFF_KEY, nodeId: 'node-a1' }] } })
  const wrongValueKeyReview = await wrongValueKey.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const wrongValueKeyResult = await wrongValueKey.adapter.nodeStatusRepairConfirm({ previewToken: wrongValueKeyReview.previewToken }, person)
  assert.deepEqual([wrongValueKeyResult.ok, wrongValueKeyResult.code], [false, CODES.UNVERIFIED], 'the changed keys the service claims do not match the real before/after diff')

  const noCommit = harness(t, { hooks: { skipCommit: true } })
  const noCommitReview = await noCommit.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const noCommitBefore = noCommit.f.disk()
  const noCommitResult = await noCommit.adapter.nodeStatusRepairConfirm({ previewToken: noCommitReview.previewToken }, person)
  assert.deepEqual([noCommitResult.ok, noCommitResult.code], [false, CODES.UNVERIFIED], 'the service reported success without ever using the commit seam')
  assert.equal(noCommit.f.disk(), noCommitBefore, 'nothing actually changed')

  const tamperedAfter = harness(t, { hooks: { afterCommit: () => {
    tamperedAfter.f.files.set(tamperedAfter.f.fleetFile, wrapperOf({ ...tamperedAfter.f.values, [TREE_KEY]: tamperedAfter.repair.repairedDocument, [DIFF_KEY]: 'tampered immediately after commit' }))
  } } })
  const tamperedReview = await tamperedAfter.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
  const tamperedResult = await tamperedAfter.adapter.nodeStatusRepairConfirm({ previewToken: tamperedReview.previewToken }, person)
  assert.deepEqual([tamperedResult.ok, tamperedResult.code], [false, CODES.UNVERIFIED], 'the durable bytes were touched again before this module could verify them')
})

test('a replacement that is not status-only is refused before it is committed, however it was staged', async t => {
  for (const [label, replacement] of [
    ['a different field changes too', wrapperOf({ ...baseValues(), [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'finished', { note: 'unexpected' }], ['node-a2', 'finished']]) })],
    ['an identity field changes too', wrapperOf({ ...baseValues(), [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'finished', { sessionId: 'swapped' }], ['node-a2', 'finished']]) })],
    ['a node is added', wrapperOf({ ...baseValues(), [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'finished'], ['node-a2', 'finished'], ['node-a9', 'finished']]) })],
    ['the chat-diff document changes too', wrapperOf({ ...baseValues(), [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'finished'], ['node-a2', 'finished']]), [DIFF_KEY]: 'slipped in' })],
    ['the change lands outside the repaired finished/turn-failed scope', wrapperOf({ ...baseValues(), [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'running'], ['node-a2', 'finished']]) })],
  ]) {
    const h = harness(t, { hooks: { replacement } })
    const reviewed = await h.adapter.nodeStatusRepairPreview({ targetIds: ['node-a1'] }, person)
    const before = h.f.disk()
    const result = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
    assert.equal(result.ok, false, label)
    assert.equal(result.code, 'FRESHNESS_REFUSED', label)
    assert.equal(result.fleetGate.code, CODES.REPLACEMENT_NOT_STATUS_ONLY, label)
    assert.equal(h.f.disk(), before, label)
    assert.equal(h.f.prefs.snapshot().fleetPending, false, label)
  }
})

test('the commit is asked the same freshness question the service should already have asked itself: a service that skips its own check and hands over bytes no one reviewed is still refused, not merely trusted', async t => {
  const h = harness(t)
  const dialog = { showMessageBox: async () => ({ response: 1 }) }
  const hostileCommits = []
  const hostileService = {
    REPAIR_ACTION: 'agent:node-status-repair', MAX_TARGETS: 64,
    async prepareRepair(args) {
      if (args.freshnessCheck({ phase: 'backup', storePath: args.storePath }) !== true) return { ok: false, code: 'FRESHNESS_REFUSED' }
      return { ok: true, previewToken: 'hostile-preview', plan: { sourceSha256: sha(h.f.disk()) }, preview: {} }
    },
    async confirmRepair(args) {
      const approved = await args.confirmNative({ backupPath: '/x.repair-backup-y.json', changes: [{ nodeId: 'node-a1' }] })
      if (approved !== true) return { ok: false, code: 'NATIVE_CONFIRM_REFUSED' }
      // Skips its own freshnessCheck call entirely and hands the commit seam bytes the person never reviewed.
      const committed = args.commitReplacement({ expectedText: h.f.disk(), replacementText: 'not even a wrapper' })
      hostileCommits.push(committed)
      if (!(committed === true || committed?.ok === true)) return { ok: false, code: committed?.error?.code, reason: committed?.error?.message }
      return { ok: true, postWriteVerified: true, postWriteSha256: sha(h.f.disk()) }
    },
  }
  const adapter = createSavedDataMaintenanceAdapter({ resolveCapabilityRoot: () => '/engine-root', requireModule: h.engine.requireModule, dialog,
    chooseSnapshotFile: async () => '/chosen/saved-snapshot.json', repairService: hostileService, rendererPrefs: h.f.prefs, fleetStorePath: h.f.fleetFile, fs: h.f.fs })
  const reviewed = await adapter.nodeStatusRepairPreview({}, person)
  assert.equal(reviewed.ok, true)
  const before = h.f.disk()
  const result = await adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.REPLACEMENT_NOT_STATUS_ONLY, JSON.stringify(result))
  assert.deepEqual(hostileCommits, [{ ok: false, error: { code: CODES.REPLACEMENT_NOT_STATUS_ONLY, message: REASONS[CODES.REPLACEMENT_NOT_STATUS_ONLY] } }])
  assert.equal(h.f.disk(), before, 'the untrusted bytes never reached the renderer-prefs seam')
})

test('changedKeys names every fleet-tree key a repair actually changed, sorted, never merely what the plan claims', async t => {
  const otherKey = 'mc.fleet.trees.v1:other-computer'
  const values = { ...baseValues(), [otherKey]: treeDocument('other-computer', [['node-b1', 'turn-failed']]) }
  const h = harness(t, { fixtureOptions: { values }, hooks: {
    replacement: wrapperOf({ ...values, [TREE_KEY]: treeDocument('this-computer', [['node-a1', 'finished'], ['node-a2', 'finished']]), [otherKey]: treeDocument('other-computer', [['node-b1', 'finished']]) }),
    changes: [{ valueKey: TREE_KEY, nodeId: 'node-a1' }, { valueKey: otherKey, nodeId: 'node-b1' }],
  } })
  const reviewed = await h.adapter.nodeStatusRepairPreview({}, person)
  const result = await h.adapter.nodeStatusRepairConfirm({ previewToken: reviewed.previewToken }, person)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.changedKeys, [TREE_KEY, otherKey].sort())
})
