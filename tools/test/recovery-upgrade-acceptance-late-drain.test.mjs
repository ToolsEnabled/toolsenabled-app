// New correction controls; no native browser or historical acceptance corpus is run.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installAccountResetFixture } from './lib/account-reset-fixture.mjs'
import vm from 'node:vm'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const recovery = require('../../shell/node-recovery-store.cjs')
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const renderer = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const origin = 'http://127.0.0.1:4601'
const key = nodeId => `${recovery.RECOVERY_KEY_PREFIX}c:${nodeId}`
const record = text => ({ v: 1, handoff: text })
const corpus = count => Array.from({ length: count }, (_, i) => [key(`orphan-${i}`), JSON.stringify(record('h'.repeat(48_000)))])
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t, { wrapStore = x => x, wrapPrefs = x => x } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-upgrade-acceptance-fix-'))
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(prefs.set('mc.theme', 'black').ok, true)
  const disk = recovery.createNodeRecoveryStore({ directory })
  const nodeRecovery = recovery.createRecoveryPersistence({ prefs: wrapPrefs(prefs), store: wrapStore(disk) })
  t.after(async () => { await nodeRecovery.stop(); fs.rmSync(directory, { recursive: true, force: true }) })
  let handler
  const scope = vm.createContext({
    nodeRecovery, rendererPrefs: prefs, shellOrigin: origin, localDataErased: false,
    trustedFleetProfileSender: event => event.trusted === true,
    prefsRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_SENDER_REFUSED' } }),
    prefsErasedRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_DATA_ERASED' } }),
    ipcMain: { on: (channel, fn) => { assert.equal(channel, 'mc-prefs:drain'); handler = fn } },
  })
  const start = main.indexOf("ipcMain.on('mc-prefs:drain'")
  const end = main.indexOf('/* THE UNINSTALL CHOICE', start)
  assert.ok(start > 0 && end > start)
  vm.runInContext(main.slice(start, end), scope)
  const drain = (entries, trusted = true) => new Promise((resolve, reject) => {
    const event = { trusted, set returnValue(value) { resolve(plain(value)) } }
    try { Promise.resolve(handler(event, { entries })).catch(reject) } catch (error) { reject(error) }
  })
  return { directory, prefs, disk, nodeRecovery, drain, scope }
}

for (const count of [21, 25]) test(`${count} late records bypass ordinary budget and survive a cold store process`, async t => {
  const f = fixture(t)
  await f.nodeRecovery.initialize() // Startup already finished before the page supplies its origin.
  const entries = corpus(count)
  const before = JSON.stringify(entries)
  const reply = await f.drain(entries)
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(Object.keys(f.prefs.snapshot().values).filter(k => k.startsWith(recovery.RECOVERY_KEY_PREFIX)).length, 0)
  assert.equal(f.prefs.isDrained(origin), true)
  assert.equal(f.prefs.set('capacity', 's'.repeat(64 * 1024)).ok, true)
  for (let i = 0; i < count; i += 1) assert.deepEqual(await f.nodeRecovery.get({ computerId: 'c', nodeId: `orphan-${i}` }), { ok: true, record: record('h'.repeat(48_000)) })
  assert.equal(JSON.stringify(entries), before, 'NO PRUNE: input snapshot unchanged')
  const cold = spawnSync(process.execPath, ['-e', `
    const {createNodeRecoveryStore}=require(process.argv[1]);
    const assert=require('node:assert/strict');
    (async()=>{const store=createNodeRecoveryStore({directory:process.argv[2]});
      for(let i=0;i<Number(process.argv[3]);i++) assert.deepEqual(await store.get({computerId:'c',nodeId:'orphan-'+i}),{ok:true,record:{v:1,handoff:'h'.repeat(48000)},legacy:true});
      console.log(JSON.stringify({pid:process.pid,count:Number(process.argv[3])}));
    })().catch(e=>{console.error(e);process.exitCode=1});
  `, require.resolve('../../shell/node-recovery-store.cjs'), f.directory, String(count)], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(cold.status, 0, cold.stderr)
  assert.notEqual(JSON.parse(cold.stdout).pid, process.pid)
})

test('actual drain handler does not reply or mark origin until delayed recovery commit finishes', async t => {
  const gate = deferred()
  let entered = false
  const f = fixture(t, { wrapStore: disk => ({ ...disk, importLegacy: async (request, options) => { entered = true; await gate.promise; return disk.importLegacy(request, options) } }) })
  let replied = false
  const pending = f.drain(corpus(1)).then(reply => { replied = true; return reply })
  try {
    await tick()
    // A get may await real disk IO before the save is reached.
    for (let i = 0; !entered && !replied && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(replied, false, 'success cannot precede the external commit')
    assert.equal(entered, true, 'the shipped handler reaches recovery storage')
    assert.equal(f.prefs.isDrained(origin), false)
    assert.equal(fs.existsSync(f.disk.directory), false)
  } finally { gate.resolve() }
  assert.equal((await pending).ok, true)
  assert.equal(f.prefs.isDrained(origin), true)
})

test('failed partial import is visible to readers and retry never overwrites an existing destination', async t => {
  let fail = true
  const f = fixture(t, { wrapStore: disk => ({ ...disk, importLegacy: (request, options) => fail && request.nodeId === 'orphan-1'
    ? Promise.resolve({ ok: false, error: { code: 'RECOVERY_WRITE_FAILED' } }) : disk.importLegacy(request, options) }) })
  const entries = corpus(2), before = fs.readFileSync(f.prefs.file)
  const refused = await f.drain(entries)
  assert.equal(refused.ok, false)
  assert.equal(f.prefs.isDrained(origin), false)
  assert.deepEqual(fs.readFileSync(f.prefs.file), before)
  assert.equal((await f.nodeRecovery.get({ computerId: 'c', nodeId: 'orphan-1' })).error.code, 'RECOVERY_MIGRATION_INCOMPLETE')
  assert.equal((await f.nodeRecovery.save({ computerId: 'c', nodeId: 'orphan-1', record: record('replacement') })).ok, false)
  // A valid external checkpoint can predate a retry/restart and must beat the native copy.
  assert.equal((await f.disk.save({ computerId: 'c', nodeId: 'orphan-0', record: record('newer') })).ok, true)
  fail = false
  assert.equal((await f.drain(entries)).ok, true)
  assert.equal((await f.nodeRecovery.get({ computerId: 'c', nodeId: 'orphan-0' })).record.handoff, 'newer')
  assert.equal((await f.nodeRecovery.get({ computerId: 'c', nodeId: 'orphan-1' })).record.handoff.length, 48_000)
})

test('final prefs refusal retains imported files and leaves origin available for retry', async t => {
  let fail = true
  const f = fixture(t, { wrapPrefs: prefs => ({ ...prefs, drain: (...args) => fail
    ? { ok: false, error: { code: 'MC_PREFS_WRITE_FAILED' } } : prefs.drain(...args) }) })
  const before = fs.readFileSync(f.prefs.file)
  assert.equal((await f.drain(corpus(1))).ok, false)
  assert.deepEqual(fs.readFileSync(f.prefs.file), before)
  assert.equal((await f.disk.get({ computerId: 'c', nodeId: 'orphan-0' })).record.handoff.length, 48_000)
  fail = false
  assert.equal((await f.drain(corpus(1))).ok, true)
})

test('stop joins active origin import and prevents remaining files and origin marker', async t => {
  const gate = deferred(), entering = deferred()
  const f = fixture(t, { wrapStore: disk => ({ ...disk, importLegacy: async (request, options) => { entering.resolve(); await gate.promise; return disk.importLegacy(request, options) } }) })
  const importing = f.drain(corpus(2))
  let stopped = false
  try {
    await Promise.race([entering.promise, importing.then(() => assert.fail('drain must await recovery storage'))])
    const stop = f.nodeRecovery.stop().then(() => { stopped = true })
    const late = f.drain(corpus(1))
    await tick()
    assert.equal(stopped, false)
    gate.resolve()
    assert.equal((await importing).error.code, 'RECOVERY_STORAGE_STOPPED')
    await stop
    assert.equal((await late).error.code, 'RECOVERY_STORAGE_STOPPED')
    assert.equal(f.prefs.isDrained(origin), false)
    assert.equal((await f.disk.get({ computerId: 'c', nodeId: 'orphan-1' })).record, null)
    fs.rmSync(f.directory, { recursive: true, force: true })
    assert.equal((await f.drain(corpus(1))).ok, false)
    assert.equal(fs.existsSync(f.directory), false)
  } finally { gate.resolve() }
})

test('drain rejects invalid recovery, aliases and ordinary overflow without marking or pruning', async t => {
  const f = fixture(t)
  for (const entries of [
    [[key('bad'), '{invalid']],
    [[key('bad'), JSON.stringify({ ...record('ok'), metadata: 'm'.repeat(70_000) })]],
    [[key('same'), JSON.stringify(record('one'))], [key('%73ame'), JSON.stringify(record('two'))]],
    Array.from({ length: 17 }, (_, i) => [`ordinary-${i}`, 'x'.repeat(64 * 1024)]),
  ]) {
    const before = fs.readFileSync(f.prefs.file), source = JSON.stringify(entries)
    assert.equal((await f.drain(entries)).ok, false)
    assert.equal(f.prefs.isDrained(origin), false)
    assert.deepEqual(fs.readFileSync(f.prefs.file), before)
    assert.equal(JSON.stringify(entries), source)
  }
})

test('sender and erased fences reject drain before disk writes', async t => {
  const f = fixture(t)
  assert.equal((await f.drain(corpus(1), false)).error.code, 'MC_PREFS_SENDER_REFUSED')
  f.scope.localDataErased = true
  assert.equal((await f.drain(corpus(1))).error.code, 'MC_PREFS_DATA_ERASED')
  assert.equal(fs.existsSync(f.disk.directory), false)
})

test('unexpected service rejection returns a structured drain refusal', async t => {
  const f = fixture(t)
  f.nodeRecovery.drainLegacyOrigin = async () => { throw new Error('unexpected service rejection') }
  assert.equal((await f.drain(corpus(1))).error.code, 'RECOVERY_MIGRATION_INCOMPLETE')
  assert.equal(f.prefs.isDrained(origin), false)
})

test('renderer publishes returned/thrown drain failure and preserves native source', () => {
  for (const throws of [false, true]) {
    const entries = new Map(corpus(1))
    const window = { localStorage: {
      get length() { return entries.size }, key: i => [...entries.keys()][i], getItem: key => entries.get(key),
      removeItem: () => assert.fail('NO PRUNE'), clear: () => assert.fail('NO PRUNE'),
    }, mcPrefs: {
      available: true, values: { 'mc.theme': 'black' }, drainRequired: true,
      drain: () => { if (throws) throw new Error('transport'); return { ok: false, error: { code: 'RECOVERY_WRITE_FAILED' } } },
      write: () => ({ ok: true }),
    } }
    vm.runInNewContext(renderer, { window, console })
    const refused = window.mcPrefsNotice.read().refused
    assert.ok(refused)
    window.localStorage.setItem('unrelated', 'kept')
    assert.deepEqual(window.mcPrefsNotice.read().refused, refused)
    assert.equal(entries.size, 1)
    assert.equal(window.localStorage.getItem('mc.theme'), 'black')
  }
})

for (const failure of ['writeFile', 'sync', 'rename', 'read']) test(`origin import preserves source on injected ${failure} failure`, async t => {
  let fail = true
  const ioError = () => { throw Object.assign(new Error('injected IO refusal'), { code: 'EIO' }) }
  const f = fixture(t, { wrapStore: disk => recovery.createNodeRecoveryStore({
    directory: path.dirname(disk.directory),
    io: {
      ...fs.promises,
      writeFile: (...args) => fail && failure === 'writeFile' ? ioError() : fs.promises.writeFile(...args),
      rename: (...args) => fail && failure === 'rename' ? ioError() : fs.promises.rename(...args),
      open: async (...args) => {
        if (fail && failure === 'read' && args[1] === 'r') ioError()
        const handle = await fs.promises.open(...args)
        if (fail && failure === 'sync' && args[1] === 'r+') return { sync: ioError, close: () => handle.close() }
        return handle
      },
    },
  }) })
  const entries = corpus(1), source = JSON.stringify(entries), before = fs.readFileSync(f.prefs.file)
  assert.equal((await f.drain(entries)).ok, false)
  assert.equal(f.prefs.isDrained(origin), false)
  assert.deepEqual(fs.readFileSync(f.prefs.file), before)
  assert.equal(JSON.stringify(entries), source)
  if (fs.existsSync(f.disk.directory)) assert.deepEqual(fs.readdirSync(f.disk.directory), [])
  fail = false
  assert.equal((await f.drain(entries)).ok, true)
})

test('retained prefs beat native origin; unreadable external destination is never overwritten', async t => {
  const f = fixture(t)
  const owner = { computerId: 'c', nodeId: 'orphan-0' }
  assert.equal(f.prefs.set(key('orphan-0'), JSON.stringify(record('retained prefs'))).ok, true)
  assert.equal((await f.disk.importLegacy({ ...owner, record: record('older external') })).ok, true)
  assert.equal((await f.drain(corpus(1))).ok, true)
  assert.equal((await f.nodeRecovery.get(owner)).record.handoff, 'retained prefs')
  const files = fs.readdirSync(f.disk.directory)
  const file = path.join(f.disk.directory, files[0])
  fs.writeFileSync(file, '{unreadable destination')
  const before = fs.readFileSync(file)
  f.scope.shellOrigin = 'http://127.0.0.1:4602'
  assert.equal((await f.drain(corpus(1))).error.code, 'RECOVERY_RECORD_UNREADABLE')
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(f.prefs.isDrained(f.scope.shellOrigin), false)
})

test('strict drain does not mark skipped ordinary keys or over-count batches as complete', async t => {
  const f = fixture(t)
  const raw = { storageVersion: 1, values: Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`key-${i}`, 'v'])), drainedOrigins: [] }
  // Reconstruct prefs from a legal on-disk key-limit fixture, without 512 fsyncs.
  fs.writeFileSync(f.prefs.file, JSON.stringify(raw))
  const prefs = createRendererPrefs({ directory: f.directory, fs, path, randomUUID })
  const before = fs.readFileSync(f.prefs.file)
  const refusal = prefs.drain(origin, [['one-too-many', 'v']], { strict: true })
  assert.equal(refusal.error.code, 'MC_PREFS_TOO_MANY_KEYS')
  assert.deepEqual(fs.readFileSync(f.prefs.file), before)
  assert.equal(prefs.isDrained(origin), false)
  assert.equal(prefs.drain(origin, [['bad']], { strict: true }).ok, false)
  assert.equal((await f.drain(Array.from({ length: 513 }, (_, i) => [`ordinary-${i}`, 'v']))).ok, false)
  assert.equal(f.prefs.isDrained(origin), false)
})

test('queued import snapshots input and a completed origin cannot resurrect a removed setting', async t => {
  const f = fixture(t), entries = corpus(1)
  entries.push(['legacy-setting', 'old'])
  const importing = f.drain(entries)
  entries[0][1] = JSON.stringify(record('changed after admission'))
  entries.push([key('late'), JSON.stringify(record('late'))])
  assert.equal((await importing).ok, true)
  assert.equal((await f.nodeRecovery.get({ computerId: 'c', nodeId: 'orphan-0' })).record.handoff.length, 48_000)
  assert.equal((await f.nodeRecovery.get({ computerId: 'c', nodeId: 'late' })).record, null)
  f.prefs.remove('legacy-setting')
  assert.equal((await f.drain(entries)).ok, true)
  assert.equal(f.prefs.snapshot().values['legacy-setting'], undefined)
})

test('shipped reset waits for active origin import then prevents post-sweep resurrection', async t => {
  const gate = deferred(), entering = deferred(), reachedResetDrain = deferred()
  const f = fixture(t, { wrapStore: disk => ({ ...disk, importLegacy: async (request, options) => { entering.resolve(); await gate.promise; return disk.importLegacy(request, options) } }) })
  const { eraseLocalData } = require('../../shell/local-data-reset.cjs')
  const { captureResetBrowserStorage } = require('../../shell/reset-browser-storage.cjs')
  let reset, sweeps = 0, stateCloses = 0, plans = 0, browserClears = 0
  const sender = { session: {
    storagePath: f.directory,
    clearStorageData: options => {
      assert.deepEqual(options, { storages: ['localstorage'] })
      assert.equal(stateCloses, 1)
      assert.equal(plans, 1)
      assert.equal(sweeps, 0)
      assert.equal(f.prefs.set('late-copy', 'refused').error.code, 'MC_PREFS_ERASED')
      browserClears += 1
      return Promise.resolve()
    },
  } }
  const researchReceipt = Object.freeze({ fixture: 'already drained' })
  Object.assign(f.scope, {
    app: { getPath: name => { assert.equal(name, 'userData'); return f.directory } },
    captureResetBrowserStorage,
    mainLagMonitor: require('../../shell/main-lag.cjs').createMainLagMonitor({ file: path.join(f.directory, 'main-lag.log') }),
    heapGuard: require('../../shell/heap-guard.cjs').createHeapGuard({
      memoryUsage: () => ({ heapUsed: 1 }), heapStatistics: () => ({ heap_size_limit: 100 }),
      write: () => assert.fail('this recovery fixture never starts diagnostic sampling'),
    }),
    appShutdown: { started: false, quiesceResearch: async () => researchReceipt, researchQuiesced: value => value === researchReceipt },
    auditIdentitySettings: null, localDataResetInFlight: false, localDataResetRefusal: null,
    ipcMain: { handle: (channel, callback) => { assert.equal(channel, 'mc-reset:erase'); reset = callback } },
    withFleetProfileSender: (event, action) => { assert.equal(event.trusted, true); return action() },
    agentRuntimeStoppedForReset: false, agentHost: null, removeAgentEventListener: null,
    agentSessions: new Map(), capabilityLayerStarting: null,
    relaySupervisor: { stop: async () => ({ ok: true, stopped: true }) }, relayFacadeCredentials: null, agentFacade: null,
    getAccountStore: () => ({ signOutEverywhere: () => ({ ok: true, revoked: true }) }),
    closeCanonicalLedger: async () => ({ ok: true, closed: true }),
    path,
    resolveCapabilityRoot: () => f.directory,
    require: module => {
      assert.equal(module, path.join(f.directory, 'src', 'lib', 'state-store.js'))
      return { sealAndCloseStateStore: () => {
        assert.equal(sweeps, 0)
        stateCloses += 1
        return { ok: true, closed: true }
      } }
    },
    capabilityLayer: null, capabilityLayerChild: null, capabilityLayerStatus: null,
    stopCapabilityLayer: async () => {}, stopAgentResources: () => {},
    appOwnedOwnerHost: null, agentSessionAuthority: null, ownerHostStatus: null,
    stopAppOwnedOwnerHost: async () => { reachedResetDrain.resolve() },
    localDataResetPlan: () => {
      assert.equal(stateCloses, 1, 'durable state closes before remeasurement')
      if (plans === 1) assert.equal(browserClears, 1, 'the final measurement follows actual browser cleanup')
      plans += 1
      return { ok: true, roots: [{ kind: 'user-data', directory: f.directory, guarded: true, present: fs.existsSync(f.directory) }] }
    },
    eraseLocalData: args => { sweeps += 1; return eraseLocalData({ ...args, env: {}, homedir: () => os.homedir() }) },
    console: { error: message => assert.fail(message) },
  })
  const start = main.indexOf("ipcMain.handle('mc-reset:erase'")
  installAccountResetFixture(f.scope, f.directory)
  const end = main.indexOf('/* Two ways to get the bootstrap proof', start)
  vm.runInContext(main.slice(start, end), f.scope)
  const importing = f.drain(corpus(2))
  try {
    await Promise.race([entering.promise, importing.then(() => assert.fail('import must reach active IO'))])
    const queued = f.drain(corpus(1))
    const resetting = reset({ trusted: true, sender })
    assert.equal(f.scope.agentRuntimeStoppedForReset, true)
    await reachedResetDrain.promise
    assert.equal(stateCloses, 0, 'an active recovery import must settle before durable-state close')
    assert.equal(plans, 0)
    assert.equal(browserClears, 0, 'active migration keeps its native browser source until the recovery queue settles')
    assert.equal(sweeps, 0)
    gate.resolve()
    assert.equal((await importing).ok, false)
    assert.equal((await queued).ok, false)
    const answer = await resetting
    assert.equal(answer.ok, true)
    assert.equal(answer.stateClosed.ok, true)
    assert.equal(answer.stateClosed.closed, true)
    assert.equal(stateCloses, 1)
    assert.deepEqual(answer.browserStorage, { attempted: true, cleared: true })
    assert.equal(browserClears, 1)
    assert.equal(plans, 2)
    assert.equal(answer.swept.complete, true)
    assert.equal(sweeps, 1)
    assert.equal(fs.existsSync(f.directory), false)
    assert.equal((await f.drain(corpus(1))).error.code, 'MC_PREFS_DATA_ERASED')
    assert.equal(fs.existsSync(f.directory), false)
  } finally { gate.resolve() }
})
