#!/usr/bin/env node
// R114 / original item 13. Disposable synthetic acceptance preparation.
// Runs shipped startup, preload, IPC and renderer blocks with real disk stores.
// VM windows/native-storage maps are NOT Chromium or packaged acceptance.
// CLI exit 3 means reproduced acceptance gaps; exit 1 means a broken assertion.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { settingsRecoveryNotice } from '../src/settings-recovery-notice.js'
import { createRecoveryHandoffStore } from '../src/recovery-handoff-store.js'
import { plainPath } from './lib/adapters/artifact-files.mjs'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const main = fs.readFileSync(path.join(root, 'shell/main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'shell/fleet-profile-preload.cjs'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'public/durable-storage.js'), 'utf8')
const recovery = require('../shell/node-recovery-store.cjs')
const { createRendererPrefs } = require('../shell/renderer-prefs.cjs')
const computerId = 'recovery-upgrade-acceptance:synthetic'
const origin = 'http://127.0.0.1:4601'
const keyFor = nodeId => `${recovery.RECOVERY_KEY_PREFIX}${encodeURIComponent(computerId)}:${encodeURIComponent(nodeId)}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.parse(JSON.stringify(value))
const writeJSON = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
const recordHashes = entries => Object.fromEntries(entries.map(([key, value]) => [key, hash(value)]))

function between(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `shipped block exists: ${from}`)
  return source.slice(start, end)
}

export function scratchParent(candidate) {
  // The shared reader fences the OS account before any filesystem probe and
  // rejects linked ancestors. Strict runs provide their own disposable TEMP.
  return fs.realpathSync.native(plainPath(candidate || os.tmpdir(), { kind: 'directory' }))
}

function corpus(count) {
  // Every record is independently valid; count/size are test inputs, not fleet measurements.
  return Array.from({ length: count }, (_, i) => [keyFor(`orphan-${i}`),
    JSON.stringify({ v: 1, handoff: 'h'.repeat(48_000), label: `synthetic orphan ${i}` })])
}

function fixture(directory, entries, { early = false, refuseMigration = false } = {}) {
  fs.mkdirSync(directory)
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(prefs.set('acceptance.last-good', 'kept').ok, true)
  if (early) for (const [key, value] of entries) assert.equal(prefs.set(key, value).ok, true)
  fs.copyFileSync(prefs.file, path.join(directory, 'initial-renderer-prefs.json'), fs.constants.COPYFILE_EXCL)
  const nativeEntries = early ? [] : entries
  writeJSON(path.join(directory, 'native-origin-source.json'), { origin, entries: nativeEntries })
  const native = new Map(nativeEntries)
  const handlers = new Map()
  const exposed = new Map()
  const trace = []
  const checkpoints = () => Object.keys(prefs.snapshot().values).filter(key => key.startsWith(recovery.RECOVERY_KEY_PREFIX))
  const disk = recovery.createNodeRecoveryStore({ directory })
  let denyWrites = refuseMigration
  const instrumented = {
    ...recovery,
    createNodeRecoveryStore: () => ({ ...disk, save: request => denyWrites
      ? Promise.resolve({ ok: false, error: { code: 'RECOVERY_WRITE_FAILED' } }) : disk.save(request) }),
  }
  const scope = vm.createContext({
    require: name => { assert.equal(name, './node-recovery-store.cjs'); return instrumented },
    app: { getPath: name => { assert.equal(name, 'userData'); return directory }, setAppUserModelId() {} },
    rendererPrefs: prefs, shellOrigin: origin, localDataErased: false,
    console: { log: message => trace.push(message), error: message => trace.push(message) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    trustedFleetProfileSender: event => event.trusted === true,
    prefsRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_SENDER_REFUSED' } }),
    prefsErasedRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_DATA_ERASED' } }),
    nodePrivacyCleanup: { recover: async () => trace.push('privacy stub') },
    showElevatedRunWarning: async () => trace.push('warning stub'),
    createWindow: () => { trace.push({ firstWindowLegacyKeys: checkpoints().length }) },
    WINDOWS_APPLICATION_ID: 'synthetic', Menu: { setApplicationMenu() {} },
    warmMachineSearchPath: async () => {}, heapGuard: { start() {} },
  })
  vm.runInContext(between(main, 'const { createNodeRecoveryStore', 'const { createNodeTranscriptCapture'), scope)
  vm.runInContext(between(main, "for (const operation of ['save', 'get'])", '/* THE UNINSTALL CHOICE'), scope)
  const startBlock = between(main.slice(main.lastIndexOf('wireSingleInstance({')), '  start: () => {', '  onStartFailure:')
  const startExpression = startBlock.trim().replace(/^start: /, '').replace(/,$/, '')
  let drainResult = null
  const window = { localStorage: {
    get length() { return native.size }, key: i => [...native.keys()][i] ?? null,
    getItem: key => native.get(key) ?? null,
    setItem() { assert.fail('drain must retain browser source') },
    removeItem() { assert.fail('NO PRUNE: drain must retain browser source') },
    clear() { assert.fail('NO PRUNE: drain must retain browser source') },
  } }
  async function start() {
    await vm.runInContext(`(${startExpression})()`, scope)
    const preloadScope = vm.createContext({
      contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
      ipcRenderer: {
        sendSync(channel, request) {
          // Settings writers delegate to the real store; bootstrap/drain execute real IPC blocks.
          if (channel === 'mc-prefs:write') return prefs.set(request.key, request.value)
          if (channel === 'mc-prefs:remove') return prefs.remove(request.key)
          if (channel === 'mc-prefs:clear') return prefs.clear()
          const event = { trusted: true }
          assert.ok(handlers.has(channel), `IPC handler exists: ${channel}`)
          handlers.get(channel)(event, request)
          if (channel === 'mc-prefs:drain') drainResult = json(event.returnValue)
          return event.returnValue
        },
        invoke(channel, request) {
          assert.ok(handlers.has(channel), `IPC handler exists: ${channel}`)
          return handlers.get(channel)({ trusted: true }, request)
        },
      },
    })
    vm.runInContext(between(preload, "contextBridge.exposeInMainWorld('mcRecovery'", "contextBridge.exposeInMainWorld('mcShell'"), preloadScope)
    vm.runInContext(between(preload, "const prefs = ipcRenderer.sendSync('mc-prefs:bootstrap')", '/* The permission level.'), preloadScope)
    window.mcPrefs = exposed.get('mcPrefs')
    window.mcRecovery = exposed.get('mcRecovery')
    vm.runInNewContext(renderer, { window, console })
  }
  return { directory, prefs, disk, window, native, checkpoints, trace, start,
    get drain() { return drainResult },
    unblock() { denyWrites = false },
    get: nodeId => exposed.get('mcRecovery').get({ computerId, nodeId }),
    stop: () => vm.runInContext('nodeRecovery.stop()', scope),
  }
}

function reopened(directory, entries) {
  // A new OS process reconstructs both stores; no parent cache can prove durability.
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const { randomUUID, createHash } = require('node:crypto');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { createRendererPrefs } = require(input.root + '/shell/renderer-prefs.cjs');
    const { createNodeRecoveryStore, createRecoveryPersistence } = require(input.root + '/shell/node-recovery-store.cjs');
    (async () => {
      const prefs = createRendererPrefs({ directory: input.directory, fs, path, randomUUID });
      const store = createNodeRecoveryStore({ directory: input.directory });
      const service = createRecoveryPersistence({ prefs, store });
      const migration = await service.initialize();
      const records = {};
      for (const nodeId of input.nodeIds) {
        const reply = await service.get({ computerId: input.computerId, nodeId });
        records[nodeId] = reply.ok && reply.record ? createHash('sha256').update(JSON.stringify(reply.record)).digest('hex') : reply;
      }
      const setting = prefs.set('acceptance.capacity', 's'.repeat(64 * 1024));
      const repeat = await service.initialize();
      await service.stop();
      console.log(JSON.stringify({ pid: process.pid, migration, repeat, records, setting, snapshot: prefs.snapshot(), list: await store.list({ computerId: input.computerId }) }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `
  const nodeIds = entries.map(([key]) => recovery.parseRecoveryKey(key).nodeId)
  const child = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify({ root, directory, computerId, nodeIds }), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  const result = JSON.parse(child.stdout)
  assert.notEqual(result.pid, process.pid)
  writeJSON(path.join(directory, 'relaunch.json'), result)
  return result
}

export async function runBaselineAcceptance({ parent } = {}) {
  const directory = fs.mkdtempSync(path.join(scratchParent(parent), 'recovery-upgrade-acceptance-'))
  const observations = []
  const cases = []
  const refs = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const report = { backlog: 'R114 / original item 13', directory, app: refs.stdout.trim(),
    expectedBase: '07091006f633d8e452ea9b6a27d0281c88f6249b',
    engine: 'f3d8bb3d81fb6a1868a13b2c4f1dbb1dafd0544c', engineExecuted: false,
    runtime: process.version, platform: process.platform,
    mode: 'synthetic Node disk + shipped VM blocks; no native window acceptance',
    sourceHashes: Object.fromEntries(['shell/main.cjs', 'shell/fleet-profile-preload.cjs', 'public/durable-storage.js',
      'shell/node-recovery-store.cjs', 'shell/renderer-prefs.cjs', 'src/recovery-handoff-store.js', 'src/settings-recovery-notice.js']
      .map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
    cases, observations, acceptance: 'OPEN: Controller native acceptance required',
  }
  const baseline = corpus(21)
  writeJSON(path.join(directory, 'seed-21.json'), { origin, entries: baseline })
  writeJSON(path.join(directory, 'seed-25.json'), { origin, entries: corpus(25) })
  for (const count of [21, 25]) {
    const entries = corpus(count)
    // Prepared for Controller's bare-page Chromium seeder, never evaluated here.
    // Refuse a product window or a nonempty origin; do not overwrite existing state.
    const seed = `(function () {
      if (!Array.from({ length: 9 }, (_, i) => 'http://127.0.0.1:' + (4601 + i)).includes(location.origin)) throw new Error('Wrong synthetic seed origin');
      if (window.mcPrefs || !(window.localStorage instanceof Storage)) throw new Error('A bare native-storage page is required');
      if (localStorage.length !== 0) throw new Error('Seed requires an empty disposable origin');
      const entries = ${JSON.stringify(entries)};
      for (const [key, value] of entries) localStorage.setItem(key, value);
      for (const [key, value] of entries) if (localStorage.getItem(key) !== value) throw new Error('Seed readback mismatch');
      return { origin: location.origin, records: entries.length, serializedValueCharacters: entries.map(([, value]) => value.length) };
    })()\n`
    new vm.Script(seed)
    fs.writeFileSync(path.join(directory, `native-seed-${count}.js`), seed, { flag: 'wx' })
  }
  const audit = `(async function () {
    if (!window.mcRecovery || !window.mcPrefsNotice) throw new Error('Product bridges are required');
    if (!/recovery-upgrade-acceptance-/i.test(window.mcPrefs.file || '')) throw new Error('Disposable acceptance profile required');
    const records = [];
    for (let i = 0; i < 25; i += 1) {
      const reply = await window.mcRecovery.get({ computerId: ${JSON.stringify(computerId)}, nodeId: 'orphan-' + i });
      const text = reply.ok && reply.record ? JSON.stringify(reply.record) : null;
      const digest = text === null ? null : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
      records.push({ nodeId: 'orphan-' + i, ok: reply.ok, error: reply.error || null, absent: reply.record === null, sha256: digest });
    }
    const banner = document.querySelector('[data-settings-recovery]');
    const box = banner && banner.getBoundingClientRect();
    return { origin: location.origin, file: window.mcPrefs.file, records, notice: window.mcPrefsNotice.read(),
      banner: banner && { text: banner.textContent, width: box.width, height: box.height, display: getComputedStyle(banner).display } };
  })()\n`
  new vm.Script(audit)
  fs.writeFileSync(path.join(directory, 'native-audit.js'), audit, { flag: 'wx' })

  for (const early of [true, false]) {
    const name = early ? 'before-startup-control' : 'late-origin-drain'
    const f = fixture(path.join(directory, name), baseline, { early })
    const sourceBefore = hash(fs.readFileSync(path.join(f.directory, 'native-origin-source.json')))
    await f.start()
    assert.equal(f.checkpoints().length, early ? 0 : 21)
    for (const [key, raw] of baseline) {
      assert.deepEqual(json((await f.get(recovery.parseRecoveryKey(key).nodeId)).record), JSON.parse(raw))
    }
    const beforeWrite = hash(fs.readFileSync(f.prefs.file))
    let refused = false
    try { f.window.localStorage.setItem('acceptance.capacity', 's'.repeat(64 * 1024)) } catch { refused = true }
    assert.equal(refused, !early)
    const notice = settingsRecoveryNotice(f.window.mcPrefsNotice.read())
    if (!early) {
      assert.equal(notice.code, 'MC_PREFS_TOO_LARGE')
      assert.equal(hash(fs.readFileSync(f.prefs.file)), beforeWrite)
      assert.equal(f.window.localStorage.getItem('acceptance.capacity'), null)
      observations.push({ code: 'LATE_DRAIN_RETAINS_SETTINGS_PRESSURE', legacyKeys: 21,
        ordinaryWrite: 'MC_PREFS_TOO_LARGE', recoveryReads: 'all retained sources readable', notice })
    }
    assert.deepEqual([...f.native], early ? [] : baseline)
    assert.equal(hash(fs.readFileSync(path.join(f.directory, 'native-origin-source.json'))), sourceBefore)
    await f.stop()
    const fresh = reopened(f.directory, baseline)
    assert.equal(fresh.migration.moved, early ? 0 : 21)
    assert.equal(fresh.repeat.moved, 0)
    assert.equal(fresh.setting.ok, true)
    assert.equal(fresh.list.nodeIds.length, 21, 'NO PRUNE: every synthetic orphan survives')
    for (const [key, raw] of baseline) assert.equal(fresh.records[recovery.parseRecoveryKey(key).nodeId], hash(raw))
    cases.push({ name, trace: f.trace, sourceBefore, sourceAfter: hash(fs.readFileSync(path.join(f.directory, 'native-origin-source.json'))),
      recordHashes: recordHashes(baseline), firstLaunchRefused: refused, freshMigration: fresh.migration, freshProcess: fresh.pid })
  }

  // This differs from the late control only in corpus count; each value is legal.
  const large = corpus(25)
  const f = fixture(path.join(directory, 'late-origin-over-budget'), large)
  const lastGood = hash(fs.readFileSync(f.prefs.file))
  await f.start()
  assert.equal(f.drain.ok, false)
  assert.equal(f.drain.error.code, 'MC_PREFS_TOO_LARGE')
  assert.equal(f.checkpoints().length, 0)
  assert.equal(f.prefs.isDrained(origin), false)
  assert.equal(hash(fs.readFileSync(f.prefs.file)), lastGood)
  assert.deepEqual([...f.native], large)
  for (let i = 0; i < 25; i += 1) assert.deepEqual(json(await f.get(`orphan-${i}`)), { ok: true, record: null })
  assert.equal(settingsRecoveryNotice(f.window.mcPrefsNotice.read()), null)
  await f.stop()
  const fresh = reopened(f.directory, large)
  assert.equal(fresh.migration.moved, 0)
  for (const reply of Object.values(fresh.records)) assert.deepEqual(reply, { ok: true, record: null })
  observations.push({ code: 'LATE_DRAIN_OVER_BUDGET_INACCESSIBLE', records: 25,
    source: 'native map and source JSON retained; ordinary durable record unchanged',
    drain: f.drain, reader: 'all 25 return ok:true, record:null', notice: null,
    relaunch: 'fresh-process startup finds no checkpoints; browser-origin retry remains native acceptance' })
  cases.push({ name: 'late-origin-over-budget', before: lastGood, trace: f.trace, sourceHashes: recordHashes(large) })

  const direct = fixture(path.join(directory, 'external-capacity-control'), [])
  await direct.start()
  const directPrefsBefore = hash(fs.readFileSync(direct.prefs.file))
  for (const [key, raw] of large) {
    const { nodeId } = recovery.parseRecoveryKey(key)
    assert.equal((await direct.window.mcRecovery.save({ computerId, nodeId, record: JSON.parse(raw) })).ok, true)
  }
  assert.equal(hash(fs.readFileSync(direct.prefs.file)), directPrefsBefore)
  assert.equal(direct.checkpoints().length, 0)
  await direct.stop()
  const directFresh = reopened(direct.directory, large)
  assert.equal(directFresh.migration.moved, 0)
  assert.equal(directFresh.setting.ok, true)
  assert.equal(directFresh.list.nodeIds.length, 25)
  for (const [key, raw] of large) assert.equal(directFresh.records[recovery.parseRecoveryKey(key).nodeId], hash(raw))
  cases.push({ name: 'external-capacity-control', records: 25, prefsBefore: directPrefsBefore,
    prefsAfter: directPrefsBefore, recordHashes: recordHashes(large), freshProcess: directFresh.pid })

  // Retained migration source beats the disk copy; oversized replacement must preserve both.
  const retained = fixture(path.join(directory, 'retained-source-retry'), corpus(1), { early: true, refuseMigration: true })
  const before = hash(fs.readFileSync(retained.prefs.file))
  await retained.start()
  // The drain's origin marker can legitimately change prefs; capture after bootstrap.
  const afterBootstrap = hash(fs.readFileSync(retained.prefs.file))
  const client = createRecoveryHandoffStore({ computerId, bridge: retained.window.mcRecovery,
    onWriteResult: (nodeId, result) => retained.window.mcPrefsNotice.reportRecoveryWrite(nodeId, result) })
  assert.equal(await client.saveRecord('orphan-0', { handoff: 'replacement' }), false)
  assert.equal(hash(fs.readFileSync(retained.prefs.file)), afterBootstrap)
  assert.equal(retained.prefs.snapshot().values[keyFor('orphan-0')], corpus(1)[0][1])
  assert.equal((await client.readRecord('orphan-0')).handoff.length, 48_000)
  assert.equal(settingsRecoveryNotice(retained.window.mcPrefsNotice.read()).code, 'RECOVERY_MIGRATION_INCOMPLETE')
  retained.unblock()
  assert.equal(await client.saveRecord('orphan-0', { handoff: '界'.repeat(48_000) }), true)
  const diskFiles = fs.readdirSync(retained.disk.directory).filter(name => name.endsWith('.json'))
  assert.equal(diskFiles.length, 1)
  const recordFile = path.join(retained.disk.directory, diskFiles[0])
  const good = hash(fs.readFileSync(recordFile))
  assert.equal(await client.saveRecord('orphan-0', { handoff: 'short', metadata: 'm'.repeat(70_000) }), false)
  assert.equal(hash(fs.readFileSync(recordFile)), good)
  assert.equal(settingsRecoveryNotice(retained.window.mcPrefsNotice.read()).code, 'RECOVERY_RECORD_TOO_LARGE')
  assert.equal((await client.readRecord('orphan-0')).handoff, '界'.repeat(48_000))
  await retained.stop()
  const expected = [[keyFor('orphan-0'), JSON.stringify({ v: 1, handoff: '界'.repeat(48_000) })]]
  assert.equal(reopened(retained.directory, expected).records['orphan-0'], hash(expected[0][1]))
  cases.push({ name: 'retained-source-retry', before, afterBootstrap, refusedSavePreservedPrefs: true,
    refusalNoticeCodes: ['RECOVERY_MIGRATION_INCOMPLETE', 'RECOVERY_RECORD_TOO_LARGE'], lastGoodRecoveryHash: good,
    nonAsciiCharacters: 48_000, oversizedMetadataCharacters: 70_000 })
  writeJSON(path.join(directory, 'report.json'), report)
  return report
}

// This preparation records the pre-correction defect. Preserve that historical
// witness after integration, separately from the current late-drain regressions.
const BASELINE_REF = '07091006f633d8e452ea9b6a27d0281c88f6249b'
const BASELINE_FILES = ['shell/main.cjs', 'shell/fleet-profile-preload.cjs',
  'public/durable-storage.js', 'shell/node-recovery-store.cjs', 'shell/renderer-prefs.cjs',
  'src/recovery-handoff-store.js', 'src/settings-recovery-notice.js']

export async function runAcceptance({ parent } = {}) {
  const source = fs.mkdtempSync(path.join(scratchParent(parent), 'recovery-upgrade-baseline-'))
  try {
    for (const relative of BASELINE_FILES) {
      const read = spawnSync('git', ['show', `${BASELINE_REF}:${relative}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
      assert.equal(read.status, 0, `Historical recovery source unavailable: ${relative}`)
      const destination = path.join(source, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, read.stdout, { flag: 'wx' })
    }
    fs.writeFileSync(path.join(source, 'package.json'), '{"type":"module"}\n', { flag: 'wx' })
    fs.mkdirSync(path.join(source, 'tools'))
    const driver = path.join(source, 'tools/recovery-upgrade-acceptance.mjs')
    fs.copyFileSync(fileURLToPath(import.meta.url), driver, fs.constants.COPYFILE_EXCL)
    // The account-fenced scratch reader belongs to this current harness, not
    // to the historical product bytes being exercised above.
    const scratchReader = path.join(source, 'tools/lib/adapters/artifact-files.mjs')
    fs.mkdirSync(path.dirname(scratchReader), { recursive: true })
    fs.copyFileSync(fileURLToPath(new URL('./lib/adapters/artifact-files.mjs', import.meta.url)), scratchReader, fs.constants.COPYFILE_EXCL)
    const historical = await import(pathToFileURL(driver).href)
    const report = await historical.runBaselineAcceptance({ parent })
    report.app = BASELINE_REF
    report.baselineSourceRef = BASELINE_REF
    report.mode = 'Historical pre-correction Node/VM witness; no current product or native acceptance'
    report.historicalSourceDirectory = path.join(report.directory, 'historical-source')
    fs.renameSync(source, report.historicalSourceDirectory)
    fs.writeFileSync(path.join(report.directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--scratch-parent')) {
    console.error('Usage: node tools/recovery-upgrade-acceptance.mjs [--scratch-parent existing-directory]')
    process.exitCode = 1
  } else {
    try {
      const report = await runAcceptance({ parent: args[1] })
      console.log(JSON.stringify({ report: path.join(report.directory, 'report.json'), cases: report.cases.length,
        observations: report.observations.map(item => item.code), acceptance: report.acceptance }, null, 2))
      process.exitCode = report.observations.length ? 3 : 0
    } catch (error) { console.error(error); process.exitCode = 1 }
  }
}
