// Cross-repository integration: MC_CANONICAL_ROOT selects the measured source
// or packed Engine. All persistence here is an in-memory FS.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests()
const retention = require(path.join(engineRoot, 'src/lib/diagnostic-retention.js'))
const { memoryFs } = require(path.join(engineRoot, 'tests/helpers/diagnostic-memory-fs.js'))
const { createProductDiagnostics } = require('../../shell/product-settings.cjs')
const { createMainLagMonitor } = require('../../shell/main-lag.cjs')
const { createExitRecordWriter } = require('../../shell/exit-record.cjs')
const { createHeapGuard } = require('../../shell/heap-guard.cjs')
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const preload = fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')

function fixture(choice = retention.DEFAULT_CHOICE) {
  const disk = memoryFs(), directory = path.resolve('synthetic-app-diagnostics')
  const timers = [], cancelled = []
  let number = 0, at = 1000
  const store = retention.createDiagnosticStore({ directory, fs: disk, pid: 42, now: () => at,
    uuid: () => '00000000-0000-0000-0000-' + String(++number).padStart(12, '0'),
    readPolicy: () => retention.resolveDiagnosticPolicy(choice),
    schedule: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer },
    cancel: timer => cancelled.push(timer) })
  const picked = [], selection = { canceled: true }
  const facade = createProductDiagnostics({ engineRoot, retentionModule: retention, store,
    chooseExport: async options => { picked.push(options); return selection } })
  return { disk, directory, store, facade, picked, selection, timers, cancelled,
    age: () => { at += 40 * 86400000 } }
}

test('real Settings facade reads without cleanup; explicit keep/export/archive use managed IDs and never overwrite', async () => {
  const f = fixture(), writer = f.facade.writer('exit-record')
  writer.append('exit fixture'); const id = writer.state().id
  assert.equal((await f.facade.keep({ id, keep: true })).ok, true)
  writer.close(); f.age()
  const view = await f.facade.inspect()
  assert.equal(view.files[0].id, id); assert.equal(view.files[0].keep, true)
  assert.equal(view.complete, true)
  assert.equal(f.disk.unlinks.filter(file => !file.endsWith('.lock')).length, 0)
  assert.equal((await f.facade.export({ id })).reason, 'cancelled')
  const target = path.resolve('synthetic-owner-export.jsonl')
  Object.assign(f.selection, { canceled: false, filePath: target })
  assert.equal((await f.facade.export({ id, destination: '/ignored-renderer-value' })).ok, true)
  assert.equal(f.disk.files.get(target).text, 'exit fixture\n')
  assert.equal((await f.facade.export({ id })).ok, false, 'existing export must survive')
  assert.equal(f.disk.files.get(target).text, 'exit fixture\n')
  assert.equal((await f.facade.archive({ id })).ok, true)
  assert.ok(f.disk.files.has(path.join(f.directory, 'archive', id, id)))
  assert.equal((await f.facade.inspect()).files.length, 0)
  assert.equal((await f.facade.keep({ id: '../saved-work', keep: true })).ok, false)
  assert.equal((await f.facade.keep({ id, keep: 'yes' })).ok, false)
})

test('actual main bootstrap applies finite or explicit Keep Chromium behavior and starts only one bounded service', async () => {
  const start = main.indexOf('const productDiagnostics =')
  const end = main.indexOf('fs.mkdirSync(CRASH_DUMP_DIR', start)
  assert.ok(start >= 0 && end > start, 'bootstrap extraction must exist')
  for (const choice of [retention.DEFAULT_CHOICE, 'Keep diagnostics', 'Archive diagnostics', 'invalid']) {
    const f = fixture(choice), switches = [], redirects = [], exits = []
    const context = { createProductDiagnostics: () => f.facade,
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      app: { getPath: kind => path.resolve('synthetic-' + kind),
        commandLine: { appendSwitch: (...args) => switches.push(args) } },
      applyChromiumLogRedirect: options => redirects.push(options),
      SHELL_USER_DATA_PATH: path.resolve('synthetic-user-data'), validateTranscriptDirectory() {},
      process: { once: (event, fn) => exits.push([event, fn]) }, console }
    const result = vm.runInNewContext(main.slice(start, end) +
      '\n;({ productDiagnostics, mainLagDiagnosticWriter, mainHeapDiagnosticWriter, exitDiagnosticWriter })', context)
    const explicit = ['Keep diagnostics', 'Archive diagnostics'].includes(choice)
    assert.equal(redirects.length, explicit ? 1 : 0)
    assert.deepEqual(switches, explicit ? [] : [['disable-logging']])
    assert.equal(f.timers.length, 1); assert.equal(f.timers[0].ms, 60000)
    assert.equal(f.disk.files.size, 0, 'bootstrap must not enroll or sweep old data')
    result.exitDiagnosticWriter.append('exit fixture')
    assert.equal(exits[0][0], 'exit'); exits[0][1]()
    assert.equal(result.exitDiagnosticWriter.append('late').reason, 'closed')
    await f.facade.dispose()
  }
})

test('real lag, heap and exit producers keep behavior while using the bounded append sink', () => {
  const f = fixture(), lagWriter = f.facade.writer('main-lag'), heapWriter = f.facade.writer('main-heap'), exitWriter = f.facade.writer('exit-record')
  const forbidLegacyFs = new Proxy({}, { get() { throw new Error('legacy filesystem sink must not be used') } })
  let wall = 1000, mono = 0, tick
  const lag = createMainLagMonitor({ file: 'unused', fs: forbidLegacyFs, appendSink: line => lagWriter.append(line),
    now: () => wall, monotonic: () => mono, intervalMs: 250, thresholdMs: 500,
    setTimer: fn => { tick = fn; return { unref() {} } }, clearTimer() {} })
  lag.start(); const done = lag.span('actual-test-work'); mono += 1500; done(); wall += 2000; tick()
  const lagLine = JSON.parse(f.disk.files.get(path.join(f.directory, lagWriter.state().id)).text.trim())
  assert.equal(lagLine.blocker, 'actual-test-work'); assert.equal(lagLine.blockerMs, 1500)
  const heap = createHeapGuard({ memoryUsage: () => ({ heapUsed: 90, rss: 150 }), heapStatistics: () => ({ heap_size_limit: 100 }),
    caches: () => [{ name: 'saved-work', size: 3 }], write: line => heapWriter.append(line), logBytes: () => heapWriter.state().bytes, resetLog: () => heapWriter.rotate() })
  assert.equal(heap.check().level, 'warn')
  assert.match(f.disk.files.get(path.join(f.directory, heapWriter.state().id)).text, /saved-work=3/)
  const exit = createExitRecordWriter({ file: 'unused', fs: forbidLegacyFs, appendSink: line => exitWriter.append(line),
    getOpenWindowCount: () => 2, getInFlightContinuationCount: () => 3 })
  assert.equal(exit.writeExitRecord('before-quit', 'owner'), true)
  const exitLine = JSON.parse(f.disk.files.get(path.join(f.directory, exitWriter.state().id)).text.trim())
  assert.equal(exitLine.openWindows, 2); assert.equal(exitLine.inFlightContinuations, 3)
  exitWriter.close(); assert.equal(exit.writeExitRecord('late', 'owner'), false)
  assert.deepEqual(f.disk.unlinks, [])
})

test('actual preload to trusted main registration drives facade and rejects a foreign sender', async () => {
  const f = fixture(), handlers = new Map(), context = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    productDiagnostics: f.facade, withFleetProfileSender: (event, run) => event.trusted ? run() : { ok: false, reason: 'sender-refused' } }
  const start = main.indexOf("for (const operation of ['inspect', 'keep', 'export', 'archive'])")
  const end = main.indexOf("ipcMain.handle('mc-settings:audit-probe'", start)
  vm.runInNewContext(main.slice(start, end), context)
  const preStart = preload.indexOf("contextBridge.exposeInMainWorld('mcSettings'")
  const preEnd = preload.indexOf('\n}))', preStart) + 4
  let bridge, trusted = true
  vm.runInNewContext(preload.slice(preStart, preEnd), {
    contextBridge: { exposeInMainWorld: (name, value) => { bridge = value } },
    ipcRenderer: { invoke: (channel, request) => handlers.get(channel)({ trusted }, request) } })
  assert.equal((await bridge.diagnosticsInspect()).ok, true)
  const writer = f.facade.writer('main-lag'); writer.append('fixture'); const id = writer.state().id
  assert.equal((await bridge.diagnosticsKeep({ id, keep: true })).ok, true)
  writer.close()
  assert.equal((await bridge.diagnosticsInspect()).files[0].keep, true)
  trusted = false
  assert.equal((await bridge.diagnosticsArchive({ id })).reason, 'sender-refused')
  assert.ok(f.disk.files.has(path.join(f.directory, id)))
})

test('unavailable Engine diagnostics are visible and never fall back to an unbounded legacy writer', async () => {
  const facade = createProductDiagnostics({ engineRoot, retentionModule: { createDiagnosticStore() { throw new Error('unavailable') }, resolveDiagnosticDirectory() { return 'synthetic' } } })
  assert.equal((await facade.inspect()).ok, false)
  assert.equal(facade.writer('exit-record').append('fixture').written, false)
  assert.equal((await facade.archive({ id: 'anything' })).ok, false)
})

test('actual main producer construction routes to managed writers, and reset awaits diagnostics disposal', async () => {
  const f = fixture(), writes = [];
  const forbidLegacyFs = new Proxy({}, { get() { throw new Error('main used a legacy file sink') } })
  let wall = 1000, mono = 0, tick
  const bindings = {
    path, SHELL_USER_DATA_PATH: path.resolve('synthetic-old-profile'), mainLagThresholdOverride: {},
    mainLagDiagnosticWriter: f.facade.writer('main-lag'), mainHeapDiagnosticWriter: f.facade.writer('main-heap'),
    exitDiagnosticWriter: f.facade.writer('exit-record'),
    createMainLagMonitor: options => createMainLagMonitor({ ...options, fs: forbidLegacyFs,
      now: () => wall, monotonic: () => mono, setTimer: fn => { tick = fn; return { unref() {} } }, clearTimer() {} }),
    createExitRecordWriter: options => createExitRecordWriter({ ...options, fs: forbidLegacyFs }),
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false }] },
    agentHost: { pendingContinuations: () => ['a', 'b'] },
    process: { memoryUsage: () => ({ heapUsed: 90, rss: 100 }) },
    require: () => ({ getHeapStatistics: () => ({ heap_size_limit: 100 }) }),
    heapGuardCaches: () => [], createHeapGuard,
    MAIN_HEAP_LOG: () => bindings.mainHeapDiagnosticWriter.state(),
  }
  function construct(startMarker, endMarker, result) {
    const start = main.indexOf(startMarker), end = main.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start)
    return vm.runInNewContext(main.slice(start, end) + '\n;' + result, bindings)
  }
  const lag = construct('const mainLagMonitor = createMainLagMonitor(', 'const mainLagInstrumentationAttached', 'mainLagMonitor')
  lag.start(); const done = lag.span('managed-main'); mono += 1500; done(); wall += 2000; tick()
  assert.ok(bindings.mainLagDiagnosticWriter.state().bytes > 0)
  assert.equal(lag.stats().writeFailures, 0)
  const exit = construct('const exitRecord = createExitRecordWriter(', "\nipcMain.handle('mc-accessibility", 'exitRecord')
  assert.equal(exit.writeExitRecord('before-quit', 'test'), true)
  assert.ok(bindings.exitDiagnosticWriter.state().bytes > 0)
  const heap = construct('const heapGuard = createHeapGuard(', '\n/* WHAT THE PAGE SAYS', 'heapGuard')
  assert.equal(heap.check().level, 'warn')
  assert.ok(bindings.mainHeapDiagnosticWriter.state().bytes > 0)

  let release, settled = false
  const gate = new Promise(resolve => { release = resolve })
  const resetStart = main.indexOf('const lagSealed = mainLagMonitor.sealForErase()')
  const resetEnd = main.indexOf("cleanupPhase = 'Browser settings ownership'", resetStart)
  const reset = vm.runInNewContext('(async () => {' + main.slice(resetStart, resetEnd) + '})', {
    mainLagMonitor: { sealForErase: () => ({ ok: true, sealed: true }) },
    heapGuard: { sealForErase: () => ({ ok: true, sealed: true }) },
    productDiagnostics: { dispose: async () => { writes.push('dispose'); await gate } },
  })
  const flight = reset().then(() => { settled = true })
  await Promise.resolve()
  assert.deepEqual(writes, ['dispose']); assert.equal(settled, false)
  release(); await flight; assert.equal(settled, true)
})

test('actual monitor attachment writes one positive readiness record and never reports it as a stall', () => {
  const start = main.indexOf('const mainLagInstrumentationAttached =')
  const end = main.indexOf('/* T180:', start)
  assert.ok(start >= 0 && end > start)
  const attachment = main.slice(start, end)
  const f = fixture(), writer = f.facade.writer('main-lag')
  const monitor = createMainLagMonitor({ file: 'unused', appendSink: line => writer.append(line) })
  const ipcMain = { handle() {}, on() {} }
  vm.runInNewContext(attachment, { mainLagMonitor: monitor, ipcMain, mainLagDiagnosticWriter: writer, process: { pid: 42 } })
  const ready = JSON.parse(f.disk.files.get(path.join(f.directory, writer.state().id)).text.trim())
  assert.equal(ready.event, 'diagnostic-sink-ready'); assert.equal(ready.producer, 'main-lag')
  assert.equal(ready.pid, 42); assert.ok(Number.isFinite(Date.parse(ready.at)))
  assert.equal(Object.hasOwn(ready, 'lagMs'), false)
  assert.equal(monitor.stats().running, false, 'initialization must not change timer start')
  assert.equal(monitor.stats().writeFailures, 0)
  assert.equal(writer.state().failure, null)

  const refused = fixture(), refusedWriter = refused.facade.writer('main-lag')
  vm.runInNewContext(attachment, { mainLagMonitor: { instrument: () => false }, ipcMain: {},
    mainLagDiagnosticWriter: refusedWriter, process: { pid: 42 } })
  assert.equal(refusedWriter.state().id, null, 'no ready record without actual attachment')

  const failed = fixture(), failedWriter = failed.facade.writer('main-lag')
  failed.disk.appendFileSync = () => { throw Object.assign(new Error('unavailable'), { code: 'EACCES' }) }
  vm.runInNewContext(attachment, { mainLagMonitor: { instrument: () => true }, ipcMain: {},
    mainLagDiagnosticWriter: failedWriter, process: { pid: 42 } })
  assert.equal(failedWriter.state().failure, 'EACCES')
  assert.equal(failedWriter.state().totalBytes, 0, 'failed initialization cannot qualify as an empty healthy log')
  assert.deepEqual(f.disk.unlinks, [])
})

test('actual inspection and disposal hold the reset continuation until close, and close refusal blocks it', async () => {
  const resetStart = main.indexOf('const lagSealed = mainLagMonitor.sealForErase()')
  const resetEnd = main.indexOf("cleanupPhase = 'Browser settings ownership'", resetStart)
  assert.ok(resetStart >= 0 && resetEnd > resetStart)
  const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
  for (const [pauseAt, closeRefused] of [['read', false], ['readCandidate', false], ['read', true]]) {
    const f = fixture(), writer = f.facade.writer('main-lag')
    writer.append('retained fixture'); writer.close()
    const entered = defer(), releaseRead = defer(), closeEntered = defer(), releaseClose = defer()
    let closed = false
    const opendir = f.disk.promises.opendir
    f.disk.promises.opendir = async (...args) => {
      const cursor = await opendir(...args)
      return { ...cursor,
        async read() { if (pauseAt === 'read') { entered.resolve(); await releaseRead.promise } return cursor.read() },
        async close() {
          closeEntered.resolve(); await releaseClose.promise
          if (closeRefused) throw Object.assign(new Error('synthetic close refusal'), { code: 'EIO' })
          await cursor.close(); closed = true
        },
      }
    }
    const readFile = f.disk.promises.readFile
    f.disk.promises.readFile = async (...args) => {
      if (pauseAt === 'readCandidate') { entered.resolve(); await releaseRead.promise }
      return readFile(...args)
    }
    const continuation = []
    const reset = vm.runInNewContext('(async () => {' + main.slice(resetStart, resetEnd) +
      '; continuation.push("reset-may-continue") })', {
      mainLagMonitor: { sealForErase: () => ({ ok: true, sealed: true }) },
      heapGuard: { sealForErase: () => ({ ok: true, sealed: true }) },
      productDiagnostics: f.facade, continuation,
    })
    const inspection = f.facade.inspect()
    await entered.promise
    const resetOutcome = reset().then(() => ({ ok: true }), error => ({ error }))
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(continuation, [], pauseAt + ': reset must wait for the admitted inspection')
      releaseRead.resolve()
      await closeEntered.promise
      assert.equal(closed, false)
      assert.deepEqual(continuation, [], 'reset must also wait for the pending close itself')
    } finally {
      releaseRead.resolve(); releaseClose.resolve()
      await Promise.all([inspection, resetOutcome])
    }
    const [view, outcome] = await Promise.all([inspection, resetOutcome])
    assert.equal(view.ok, false, 'a stale inspection must not publish rows after disposal')
    if (closeRefused) {
      assert.equal(outcome.error.code, 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED')
      assert.equal(f.store.status().disposal.confirmed, false)
      assert.deepEqual(continuation, [])
    } else {
      assert.equal(outcome.ok, true); assert.equal(closed, true)
      assert.equal(f.store.status().disposal.confirmed, true)
      assert.deepEqual(continuation, ['reset-may-continue'])
    }
    assert.deepEqual(f.disk.unlinks, [], 'this proof never executes real or simulated erasure')
  }
})
