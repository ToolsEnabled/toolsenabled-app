// Execute the shipped startup callback and preload/IPC blocks with real stores.
// Electron's process boundary and native filesystem behavior remain native QA.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installAccountResetFixture } from './lib/account-reset-fixture.mjs'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'

const require = createRequire(import.meta.url)
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const preload = fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')
const recoveryModule = require('../../shell/node-recovery-store.cjs')

function between(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `shipped block exists: ${from}`)
  return source.slice(start, end)
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-capacity-wiring-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  for (let i = 0; i < 23; i += 1) {
    assert.equal(prefs.set(`mc.agent-recovery.v1:c:n${i}`, JSON.stringify({ v: 1, handoff: 'h'.repeat(43_600) })).ok, true)
  }
  assert.equal(prefs.set('mc.theme', 'black').ok, true)
  const handlers = new Map()
  const exposed = new Map()
  const order = []
  const scope = vm.createContext({
    require: name => { assert.equal(name, './node-recovery-store.cjs'); return recoveryModule },
    app: { getPath: name => { assert.equal(name, 'userData'); return directory }, setAppUserModelId: () => {} },
    rendererPrefs: prefs,
    console: { log() {}, error() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedFleetProfileSender: event => event.trusted === true,
    prefsRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_SENDER_REFUSED' } }),
    prefsErasedRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_DATA_ERASED' } }),
    localDataErased: false,
    nodePrivacyCleanup: { recover: async () => { order.push('privacy') } },
    showElevatedRunWarning: async () => { order.push('warning') },
    createWindow: async () => {
      order.push('window')
      assert.equal(Object.keys(prefs.snapshot().values).filter(key => key.startsWith('mc.agent-recovery')).length, 0)
      assert.equal(fs.readdirSync(path.join(directory, 'node-recovery')).filter(name => name.endsWith('.json')).length, 23)
    },
    WINDOWS_APPLICATION_ID: 'test', Menu: { setApplicationMenu() {} },
    warmMachineSearchPath: async () => {}, heapGuard: { start() {} },
  })
  vm.runInContext(between(main, 'const { createNodeRecoveryStore', 'const { createNodeTranscriptCapture'), scope)
  vm.runInContext(between(main, "for (const operation of ['save', 'get', 'remove', 'list'])", "ipcMain.on('mc-prefs:bootstrap'"), scope)
  const preloadScope = vm.createContext({
    contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
    ipcRenderer: { invoke: (channel, request) => {
      assert.ok(handlers.has(channel), 'every invoked recovery channel has a handler')
      return handlers.get(channel)({ trusted: true }, request)
    } },
  })
  vm.runInContext(between(preload, "contextBridge.exposeInMainWorld('mcRecovery'", "contextBridge.exposeInMainWorld('mcShell'"), preloadScope)
  const block = between(main.slice(main.lastIndexOf('wireSingleInstance({')), '  start: () => {', '  onStartFailure:')
  const expression = block.trim().replace(/^start: /, '').replace(/,$/, '')
  const start = () => vm.runInContext(`(${expression})()`, scope)
  return { directory, prefs, handlers, scope, start, order, bridge: exposed.get('mcRecovery') }
}

test('startup migrates 23 records before the first window; actual preload and IPC keep subsequent handoffs outside settings', async t => {
  const f = fixture(t)
  await f.start()
  assert.deepEqual(f.order, ['privacy', 'warning', 'window'])
  const before = fs.readFileSync(f.prefs.file)
  const storage = { write() { assert.fail('bridged recovery must not write renderer settings') } }
  const client = createRecoveryHandoffStore({ computerId: 'c', storage, bridge: f.bridge })
  assert.equal(await client.saveRecord('n23', { handoff: '界'.repeat(48_000), sessionId: 's' }), true)
  assert.equal((await client.readRecord('n23')).handoff, '界'.repeat(48_000))
  assert.deepEqual(fs.readFileSync(f.prefs.file), before)
  assert.equal(fs.readdirSync(path.join(f.directory, 'node-recovery')).length, 24)
  const again = recoveryModule.createRecoveryPersistence({ prefs: f.prefs,
    store: recoveryModule.createNodeRecoveryStore({ directory: f.directory }) })
  assert.equal((await again.initialize()).moved, 0)
  assert.equal((await again.get({ computerId: 'c', nodeId: 'n23' })).record.handoff, '界'.repeat(48_000))
})

test('actual recovery IPC refuses an untrusted sender, erased data, and an oversized replacement', async t => {
  const f = fixture(t)
  await f.start()
  const request = { computerId: 'c', nodeId: 'n0', record: { v: 1, handoff: 'ok', junk: 'x'.repeat(2_000_000) } }
  const save = f.handlers.get('mc-recovery:save')
  assert.equal((await save({ trusted: false }, request)).error.code, 'MC_PREFS_SENDER_REFUSED')
  f.scope.localDataErased = true
  assert.equal((await save({ trusted: true }, request)).error.code, 'MC_PREFS_DATA_ERASED')
  f.scope.localDataErased = false
  assert.equal((await save({ trusted: true }, request)).error.code, 'RECOVERY_RECORD_TOO_LARGE')
  assert.equal((await f.bridge.get(request)).record.handoff, 'h'.repeat(43_600))
})

test('the Computers surface constructs its coordinator checkpoint store with the preload bridge', () => {
  const computers = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  assert.match(computers, /handoffStore:\s*createRecoveryHandoffStore\(\{[^}]*bridge:\s*window\.mcRecovery/)
})

test('reset and quit join the recovery queue before erasing data or returning', () => {
  const reset = between(main, "ipcMain.handle('mc-reset:erase'", '/* Two ways to get the bootstrap proof')
  assert.ok(reset.indexOf('nodeRecovery.stop()') < reset.indexOf('await hostForReset?.closeAll()'))
  assert.ok(reset.indexOf('await recoveryStoppedForReset') < reset.indexOf('const plan = localDataResetPlan()'))
  const quit = between(main, 'async function closeAgentSessionsForQuit()', "app.on('before-quit'")
  assert.match(quit, /const recoveryStoppedForQuit = nodeRecovery.stop\(\)/)
  assert.match(quit, /await recoveryStoppedForQuit/)
})

test('actual reset waits for a delayed recovery write and fences queued and late IPC saves before sweeping', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-recovery-reset-race-'))
  const tasks = []
  let releaseWrite, enterWrite, reachDrain, releaseBrowser, reachBrowser
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const writing = new Promise(resolve => { enterWrite = resolve })
  const drainReached = new Promise(resolve => { reachDrain = resolve })
  const browserGate = new Promise(resolve => { releaseBrowser = resolve })
  const browserReached = new Promise(resolve => { reachBrowser = resolve })
  t.after(async () => {
    releaseWrite()
    releaseBrowser()
    await Promise.allSettled(tasks)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(prefs.set('mc.theme', 'black').ok, true)
  const io = { ...fs.promises, mkdir: async (...args) => {
    enterWrite()
    await writeGate
    return fs.promises.mkdir(...args)
  } }
  const nodeRecovery = recoveryModule.createRecoveryPersistence({ prefs,
    store: recoveryModule.createNodeRecoveryStore({ directory, io }) })
  const { eraseLocalData } = require('../../shell/local-data-reset.cjs')
  const { captureResetBrowserStorage } = require('../../shell/reset-browser-storage.cjs')
  const handlers = new Map()
  let plans = 0, sweeps = 0, stateCloses = 0, browserClears = 0, browserSettled = false
  const sender = { session: {
    storagePath: directory,
    clearStorageData: options => {
      assert.deepEqual(options, { storages: ['localstorage'] }, 'native clear must cover all former origins')
      assert.equal(plans, 1, 'only the preliminary plan may exist when browser cleanup starts')
      assert.equal(sweeps, 0)
      browserClears += 1
      reachBrowser()
      return browserGate.then(() => { browserSettled = true })
    },
  } }
  const researchReceipt = Object.freeze({ fixture: 'already drained' })
  const scope = vm.createContext({
    app: { getPath: name => { assert.equal(name, 'userData'); return directory } },
    captureResetBrowserStorage, rendererPrefs: prefs,
    mainLagMonitor: require('../../shell/main-lag.cjs').createMainLagMonitor({ file: path.join(directory, 'main-lag.log') }),
    heapGuard: require('../../shell/heap-guard.cjs').createHeapGuard({
      memoryUsage: () => ({ heapUsed: 1 }), heapStatistics: () => ({ heap_size_limit: 100 }),
      write: () => assert.fail('this recovery fixture never starts diagnostic sampling'),
    }),
    appShutdown: { started: false, quiesceResearch: async () => researchReceipt, researchQuiesced: value => value === researchReceipt },
    auditIdentitySettings: null, localDataResetInFlight: false, localDataResetRefusal: null,
    nodeRecovery,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    trustedFleetProfileSender: event => event.trusted === true,
    withFleetProfileSender: (event, action) => { assert.equal(event.trusted, true); return action() },
    prefsRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_SENDER_REFUSED' } }),
    prefsErasedRefusal: () => ({ ok: false, error: { code: 'MC_PREFS_DATA_ERASED' } }),
    localDataErased: false,
    agentRuntimeStoppedForReset: false, agentHost: null, removeAgentEventListener: null,
    agentSessions: new Map(), capabilityLayerStarting: null,
    relaySupervisor: { stop: async () => ({ ok: true, stopped: true }) }, relayFacadeCredentials: null, agentFacade: null,
    getAccountStore: () => ({ signOutEverywhere: () => ({ ok: true, revoked: true }) }),
    closeCanonicalLedger: async () => ({ ok: true, closed: true }),
    path,
    resolveCapabilityRoot: () => directory,
    require: module => {
      assert.equal(module, path.join(directory, 'src', 'lib', 'state-store.js'))
      return { sealAndCloseStateStore: () => {
        assert.equal(plans, 0)
        assert.equal(sweeps, 0)
        stateCloses += 1
        return { ok: true, closed: true }
      } }
    },
    capabilityLayer: null, capabilityLayerChild: null, capabilityLayerStatus: null,
    stopCapabilityLayer: async () => {}, stopAgentResources: () => {},
    appOwnedOwnerHost: null, agentSessionAuthority: null, ownerHostStatus: null,
    stopAppOwnedOwnerHost: async () => { reachDrain() },
    localDataResetPlan: () => {
      assert.equal(stateCloses, 1, 'durable state must close after recovery drains and before remeasurement')
      if (plans === 1) assert.equal(browserSettled, true, 'the final plan must wait for browser cleanup')
      plans += 1
      return { ok: true, roots: [{ kind: 'user-data', directory, guarded: true, present: fs.existsSync(directory) }] }
    },
    eraseLocalData: args => {
      sweeps += 1
      assert.equal(scope.localDataErased, true, 'the existing erase flag must be set before the sweep')
      return eraseLocalData({ ...args, env: {}, homedir: () => os.homedir() })
    },
    console: { error: message => assert.fail(message) },
  })
  vm.runInContext(between(main, "for (const operation of ['save', 'get', 'remove', 'list'])", "ipcMain.on('mc-prefs:bootstrap'"), scope)
  installAccountResetFixture(scope, directory)
  vm.runInContext(between(main, "ipcMain.handle('mc-reset:erase'", '/* Two ways to get the bootstrap proof'), scope)
  const save = nodeId => handlers.get('mc-recovery:save')({ trusted: true }, {
    computerId: 'c', nodeId, record: { v: 1, handoff: 'checkpoint must settle before erase' },
  })
  const first = save('in-flight'); tasks.push(first)
  await writing
  const queued = save('queued-before-reset'); tasks.push(queued)
  const resetting = handlers.get('mc-reset:erase')({ trusted: true, sender }); tasks.push(resetting)
  assert.equal(scope.agentRuntimeStoppedForReset, true)
  const late = save('arrived-during-reset'); tasks.push(late)
  await drainReached
  assert.equal(stateCloses, 0, 'durable state must remain available until the recovery write settles')
  assert.equal(plans, 0, 'reset must not measure/sweep while the checkpoint write is pending')
  assert.equal(sweeps, 0)
  assert.equal(fs.existsSync(directory), true)
  releaseWrite()
  assert.equal((await first).ok, true)
  assert.equal((await queued).error.code, 'RECOVERY_STORAGE_STOPPED')
  assert.equal((await late).error.code, 'RECOVERY_STORAGE_STOPPED')
  await Promise.race([browserReached, resetting.then(() => assert.fail('reset must await the real browser completion seam'))])
  assert.equal(plans, 1)
  assert.equal(sweeps, 0, 'pending browser cleanup must not permit filesystem deletion')
  assert.equal(scope.localDataErased, true, 'the shell write fence precedes the asynchronous browser clear')
  const beforeRefusedWrite = fs.readFileSync(prefs.file)
  assert.equal(prefs.set('mc.theme', 'white').error.code, 'MC_PREFS_ERASED', 'retained writers cannot bypass the IPC fence')
  assert.deepEqual(fs.readFileSync(prefs.file), beforeRefusedWrite)
  releaseBrowser()
  const answer = await resetting
  assert.equal(answer.ok, true)
  assert.equal(answer.stateClosed.ok, true)
  assert.equal(answer.stateClosed.closed, true)
  assert.equal(stateCloses, 1)
  assert.deepEqual(answer.browserStorage, { attempted: true, cleared: true })
  assert.equal(browserClears, 1)
  assert.equal(plans, 2)
  assert.equal(sweeps, 1)
  assert.equal(answer.swept.complete, true)
  assert.equal(fs.existsSync(directory), false)
  assert.equal((await save('after-reset')).error.code, 'MC_PREFS_DATA_ERASED')
  assert.equal(fs.existsSync(directory), false, 'no accepted continuation may recreate node-recovery after erase')
})
