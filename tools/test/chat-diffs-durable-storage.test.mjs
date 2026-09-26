// Actual chat-history producer -> safe storage -> durable browser bridge -> disk.
// All documents, failures and paths below are fictional test-owned fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { safeTreeStorage } from '../../src/fleet-trees.js'
import { boundedChangePatches } from '../../src/session-change-patches.js'

const require = createRequire(import.meta.url)
const { createRendererPrefs, MAX_VALUE_LENGTH, MAX_RECORD_BYTES, RECORD_FILE, RENDERER_FLEET_FILE } = require('../../shell/renderer-prefs.cjs')
const durableSource = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const viewSource = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const start = viewSource.indexOf("const CHAT_DIFF_HISTORY_KEY_BASE = 'mc.fleet.chat-diffs.v1'")
const end = viewSource.indexOf('/* A SAVE MUST NOT LEAVE', start)
assert.ok(start >= 0 && end > start, 'Load the complete current production chat-history store')
const createHistory = new Function('boundedChangePatches', `${viewSource.slice(start, end)}; return createChatDiffHistoryStore`)(boundedChangePatches)
const Mi = 1024 * 1024
const key = 'mc.fleet.chat-diffs.v1:fixture-computer'

function fixture(t, io = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-chat-diffs-prefs-'))
  const instances = []
  const open = () => {
    const prefs = createRendererPrefs({ directory, fs: io, path, randomUUID })
    instances.push(prefs)
    return prefs
  }
  t.after(() => {
    for (const prefs of instances) prefs.sealForErase()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, open, prefs: open(), file: path.join(directory, RECORD_FILE),
    fleetFile: path.join(directory, RENDERER_FLEET_FILE) }
}

async function flush(prefs) {
  assert.equal((await prefs.flushFleetDocuments()).ok, true)
  assert.equal(prefs.snapshot().fleetPending, false)
  assert.equal(prefs.snapshot().fleetWriteError, null)
}

function renderer(prefs, write = (name, value) => prefs.set(name, value)) {
  const snapshot = prefs.snapshot()
  const window = { localStorage: { length: 0 }, mcPrefs: {
    available: true, ...snapshot, file: prefs.file, drainRequired: false,
    write, remove: name => prefs.remove(name), clear: () => prefs.clear(),
  } }
  vm.runInNewContext(durableSource, { window })
  return { prefs, window, history: createHistory({ computerId: 'fixture-computer', storage: safeTreeStorage(window.localStorage) }) }
}

function entries(label, count = 8, patchSize = 131072) {
  return Array.from({ length: count }, (_, index) => ({ who: 'diff', source: 'session-file-change',
    id: `${label}-${index}`, at: index + 1, files: [{ path: `${label}/${index}.txt`, status: 'M', added: 1, removed: 1 }],
    patches: [{ path: `${label}/${index}.txt`, diff: '+'.padEnd(patchSize, label) }], activeIndex: 0 }))
}

test('full retained patches from several nodes survive disk reopen and another node update', async t => {
  const f = fixture(t)
  assert.equal(f.prefs.set('mc.theme', 'black').ok, true)
  const live = renderer(f.prefs)
  const expected = { alpha: entries('alpha'), beta: entries('beta'), gamma: entries('gamma') }
  for (const [node, history] of Object.entries(expected)) assert.equal(live.history.save(node, history), true, node)
  await flush(f.prefs)
  assert.ok(fs.statSync(f.fleetFile).size > 3 * Mi)
  assert.ok(fs.statSync(f.file).size < MAX_RECORD_BYTES)
  const reopened = renderer(f.open())
  for (const [node, history] of Object.entries(expected)) assert.deepEqual(reopened.history.get(node), history)
  expected.beta = entries('revised-beta')
  assert.equal(reopened.history.save('beta', expected.beta), true)
  await flush(reopened.prefs)
  const final = renderer(f.open())
  for (const [node, history] of Object.entries(expected)) assert.deepEqual(final.history.get(node), history)
  assert.equal(final.window.localStorage.getItem('mc.theme'), 'black')
  assert.equal(final.window.mcPrefsNotice.read().refused, null)
  assert.equal(final.history.remove('beta'), true)
  await flush(final.prefs)
  const afterRemove = renderer(f.open())
  assert.deepEqual(afterRemove.history.get('beta'), [])
  assert.deepEqual(afterRemove.history.get('alpha'), expected.alpha)
  assert.deepEqual(afterRemove.history.get('gamma'), expected.gamma)
})

test('a real successful retry clears only the failed chat save and preserves every retained patch', async t => {
  const f = fixture(t)
  let fail = true
  const live = renderer(f.prefs, (name, value) => fail
    ? { ok: false, error: { code: 'MC_PREFS_WRITE_FAILED', message: 'Synthetic write refusal.' } }
    : f.prefs.set(name, value))
  const history = entries('retry')
  assert.equal(live.history.save('node', history), false)
  assert.equal(live.window.mcPrefsNotice.read().refused.key, key)
  fail = false
  live.window.localStorage.setItem('mc.theme', 'black')
  assert.equal(live.window.mcPrefsNotice.read().refused.key, key, 'Another setting cannot clear a failed history save')
  assert.equal(live.history.save('node', history), true)
  assert.equal(live.window.mcPrefsNotice.read().refused, null)
  await flush(f.prefs)
  assert.deepEqual(renderer(f.open()).history.get('node'), history)
})

test('strict legacy import and transient read recovery preserve large accepted chat documents', async t => {
  let readsToFail = 0
  const io = new Proxy(fs, { get(target, name) {
    if (name === 'readFileSync') return (...args) => {
      if (readsToFail-- > 0) throw Object.assign(new Error('Synthetic busy read'), { code: 'EBUSY' })
      return fs.readFileSync(...args)
    }
    return target[name]
  } })
  const f = fixture(t, io)
  const value = JSON.stringify({ v: 1, nodes: { imported: entries('imported') } })
  const result = f.prefs.drain('http://127.0.0.1:4604', [[key, value], ['mc.theme', 'black']], { strict: true })
  assert.equal(result.ok, true)
  assert.equal(result.migrated, 2)
  await flush(f.prefs)
  readsToFail = 2
  const snapshot = f.open().snapshot()
  assert.equal(snapshot.damaged, null)
  assert.equal(snapshot.values[key], value)
  assert.equal(snapshot.values['mc.theme'], 'black')
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [RECORD_FILE, RENDERER_FLEET_FILE].sort(), 'Only the two current storage partitions; no quarantine or rewritten smaller copy')
})

test('only the exact chat document namespace receives the document envelope', async t => {
  const f = fixture(t)
  const large = 'x'.repeat(MAX_VALUE_LENGTH + 1)
  assert.equal(f.prefs.set(key, large).ok, true)
  for (const nearMiss of ['mc.fleet.chat.v1:c', 'mc.fleet.chat-diffs.v2:c', 'mc.fleet.chat-diffs.v1:',
    'mc.fleet.chat-diffs.v1:c\n', 'mc.fleet.chat-diffs.v1:' + 'x'.repeat(181), 'prefix.' + key,
    'acct:fictional:' + key, 'mc.theme']) {
    const result = f.prefs.set(nearMiss, large)
    assert.equal(result.ok, false, JSON.stringify(nearMiss))
    assert.equal(result.error.code, 'MC_PREFS_INVALID_ENTRY')
  }
  await flush(f.prefs)
  assert.equal(f.open().snapshot().values[key], large)
})

test('chat documents retain the existing 32 Mi character cell limit and refuse without mutation', async t => {
  const f = fixture(t)
  const within = 'x'.repeat(32 * Mi)
  assert.equal(f.prefs.set(key, within).ok, true)
  await flush(f.prefs)
  const before = fs.readFileSync(f.fleetFile)
  const result = f.prefs.set(key, within + 'x')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_PREFS_INVALID_ENTRY')
  assert.deepEqual(fs.readFileSync(f.fleetFile), before)
  assert.equal(f.prefs.snapshot().values[key], within)
  assert.equal(f.open().snapshot().values[key], within)
})

test('UTF-8 record bytes still bound a chat document whose character count fits', async t => {
  const f = fixture(t)
  assert.equal(f.prefs.set(key, 'previous document').ok, true)
  await flush(f.prefs)
  const before = fs.readFileSync(f.fleetFile)
  const large = '界'.repeat(23 * Mi)
  assert.ok(large.length < 32 * Mi && Buffer.byteLength(large) > 64 * Mi)
  const result = f.prefs.set(key, large)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_PREFS_TOO_LARGE')
  assert.deepEqual(fs.readFileSync(f.fleetFile), before)
  assert.equal(f.prefs.snapshot().values[key], 'previous document')
  assert.equal(f.open().snapshot().values[key], 'previous document')
})

test('tree and chat documents share the unchanged 64 MiB aggregate budget', async t => {
  const f = fixture(t)
  const treeKey = 'mc.fleet.trees.v1:fixture-computer'
  assert.equal(f.prefs.set(treeKey, 't'.repeat(26 * Mi)).ok, true)
  assert.equal(f.prefs.set(key, 'd'.repeat(26 * Mi)).ok, true)
  await flush(f.prefs)
  const before = fs.readFileSync(f.fleetFile)
  const result = f.prefs.set('mc.fleet.chat-diffs.v1:another-computer', 'n'.repeat(13 * Mi))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_PREFS_TOO_LARGE')
  assert.deepEqual(fs.readFileSync(f.fleetFile), before)
  assert.equal(f.prefs.snapshot().values['mc.fleet.chat-diffs.v1:another-computer'], undefined)
  assert.deepEqual(f.open().snapshot().values, f.prefs.snapshot().values)
})

test('a large chat document does not consume or enlarge the ordinary preference budget', async t => {
  const f = fixture(t)
  assert.equal(f.prefs.set(key, 'd'.repeat(2 * Mi)).ok, true)
  const cell = 'p'.repeat(MAX_VALUE_LENGTH)
  for (let index = 0; index < 15; index++) assert.equal(f.prefs.set(`mc.fixture.${index}`, cell).ok, true)
  const before = fs.readFileSync(f.file)
  const refused = f.prefs.set('mc.fixture.overflow', cell)
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'MC_PREFS_TOO_LARGE')
  assert.deepEqual(fs.readFileSync(f.file), before)
  const ordinary = { ...JSON.parse(before), values: { ...f.prefs.snapshot().values } }
  delete ordinary.values[key]
  assert.ok(Buffer.byteLength(JSON.stringify(ordinary)) < MAX_RECORD_BYTES)
  assert.equal(f.prefs.set('mc.theme', 'black').ok, true)
  await flush(f.prefs)
  assert.equal(f.open().snapshot().values[key].length, 2 * Mi)
})

test('disk failure keeps prior durable nodes and reports the pending write until a real retry succeeds', async t => {
  let refuseRename = false
  const io = new Proxy(fs, { get(target, name) {
    if (name === 'promises') return new Proxy(fs.promises, { get(promises, method) {
      if (method === 'rename') return async (...args) => {
        if (refuseRename) throw Object.assign(new Error('Synthetic disk failure'), { code: 'ENOSPC' })
        return promises.rename(...args)
      }
      return promises[method]
    } })
    return target[name]
  } })
  const f = fixture(t, io)
  const live = renderer(f.prefs)
  const saved = entries('saved', 1, 100)
  assert.equal(live.history.save('saved', saved), true)
  await flush(f.prefs)
  const before = fs.readFileSync(f.fleetFile)
  refuseRename = true
  const pending = entries('new')
  assert.equal(live.history.save('new', pending), true, 'Fleet writes are accepted in memory before the asynchronous disk flush')
  assert.equal((await f.prefs.flushFleetDocuments()).error.code, 'MC_PREFS_WRITE_FAILED')
  assert.equal(f.prefs.snapshot().fleetPending, true)
  assert.equal(f.prefs.snapshot().fleetWriteError, 'ENOSPC')
  assert.deepEqual(fs.readFileSync(f.fleetFile), before)
  assert.deepEqual(live.history.get('saved'), saved)
  assert.deepEqual(live.history.get('new'), pending, 'Retain the unsaved change for retry')
  const prior = renderer(f.open())
  assert.deepEqual(prior.history.get('saved'), saved)
  assert.deepEqual(prior.history.get('new'), [], 'A failed flush must not appear in a cold reopen')
  assert.deepEqual(fs.readdirSync(f.directory), [RENDERER_FLEET_FILE], 'Failed temporary file is closed and removed')
  refuseRename = false
  await flush(f.prefs)
  const recovered = renderer(f.open())
  assert.deepEqual(recovered.history.get('saved'), saved)
  assert.deepEqual(recovered.history.get('new'), pending)
})
