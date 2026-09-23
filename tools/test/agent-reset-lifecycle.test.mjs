import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import capabilityLayer from '../../shell/capability-layer.cjs'
import shutdown from '../../shell/research-shutdown.cjs'
import browserStorage from '../../shell/reset-browser-storage.cjs'
import rendererPrefsModule from '../../shell/renderer-prefs.cjs'
import mainLagModule from '../../shell/main-lag.cjs'
import heapGuardModule from '../../shell/heap-guard.cjs'
import { installAccountResetFixture } from './lib/account-reset-fixture.mjs'

const MAIN = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

function between(start, end) {
  const first = MAIN.indexOf(start)
  const last = MAIN.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, `missing source interval: ${start} .. ${end}`)
  return MAIN.slice(first, last)
}

function assertOrdered(source, tokens) {
  let cursor = -1
  for (const token of tokens) {
    const found = source.indexOf(token, cursor + 1)
    assert.ok(found > cursor, `${token} must occur after the preceding reset step`)
    cursor = found
  }
}

test('local-data reset seals admission and retains cleanup custody until both close barriers settle', () => {
  const reset = between("ipcMain.handle('mc-reset:erase'", '/* Two ways to get the bootstrap proof')

  assertOrdered(reset, [
    'agentRuntimeStoppedForReset = true',
    'stopAccountAdmissionForReset()',
    'const hostForReset = agentHost',
    'await hostForReset?.closeAll()',
    'const capabilityStartForReset = capabilityLayerStarting',
    'await capabilityStartForReset',
    'await appShutdown.quiesceResearch()',
    'await relaySupervisor.stop()',
    'relayFacadeCredentials = null',
    'await agentFacade?.close()',
    'await closeAccountWritersForReset()',
    'closeCanonicalLedger()',
    'await stopCapabilityLayer(child, { requireExit: true })',
    'capabilityLayerStarting = null',
    'await stopAppOwnedOwnerHost(authorityHost, { requireClose: true })',
    'agentSessionAuthority = null',
    'await recoveryStoppedForReset',
    'stateStore.sealAndCloseStateStore()',
    'mainLagMonitor.sealForErase()',
    'heapGuard.sealForErase()',
    'captureResetBrowserStorage(',
    'rendererPrefs.sealForErase()',
    'localDataErased = true',
    'await browserReset.clear()',
    'appShutdown.researchQuiesced(research)',
    'if (!stillOwnsReset())',
    'browserReset.revalidate(',
    'const plan = localDataResetPlan()',
    'browserReset.validatePlan(plan)',
    'eraseLocalData({',
  ])

  const beforeFirstAwait = reset.slice(0, reset.indexOf('await hostForReset?.closeAll()'))
  assert.match(beforeFirstAwait, /agentRuntimeStoppedForReset = true/,
    'the admission gate must be synchronous')
  assert.equal(beforeFirstAwait.includes('agentHost = null'), false,
    'a pending or refused close must retain its exact cleanup handle for retry')
  assert.equal((reset.match(/const plan = localDataResetPlan\(\)/g) || []).length, 1,
    'erase must make exactly one final measurement after stopping runtime writers')
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function resetFixture(t, overrides = {}, accountOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'reset-quiescence-'))
  const sentinel = join(directory, 'owner-data.txt')
  writeFileSync(sentinel, 'retained until every runtime holder is confirmed stopped')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = []
  let diagnosticClock = 1000
  const diagnosticTicks = {}
  const mainLagMonitor = mainLagModule.createMainLagMonitor({
    file: join(directory, 'main-lag.log'), intervalMs: 10, thresholdMs: 20,
    now: () => diagnosticClock,
    setTimer: callback => { diagnosticTicks.lag = callback; return { unref() {} } },
    clearTimer() {},
  })
  const heapGuard = heapGuardModule.createHeapGuard({
    memoryUsage: () => ({ heapUsed: 90, rss: 100 }),
    heapStatistics: () => ({ heap_size_limit: 100 }),
    write: line => fs.appendFileSync(join(directory, 'main-heap.log'), line),
    setTimer: callback => { diagnosticTicks.heap = callback; return { unref() {} } },
    clearTimer() {},
  })
  mainLagMonitor.start()
  heapGuard.start()
  const tickDiagnostics = () => { diagnosticClock += 1000; diagnosticTicks.lag(); diagnosticTicks.heap() }
  const prefs = rendererPrefsModule.createRendererPrefs({ directory, fs, path, randomUUID })
  const seal = prefs.sealForErase.bind(prefs)
  prefs.sealForErase = () => { calls.push('seal-prefs'); return seal() }
  const sender = { session: { storagePath: directory, clearStorageData: async options => {
    calls.push('clear-browser')
    assert.deepEqual(options, { storages: ['localstorage'] })
  } } }
  const event = { trusted: true, sender }
  const accepted = new WeakMap()
  const appShutdown = shutdown.createAppShutdownCoordinator({ quit() { assert.fail('reset must not quit') } })
  function registerResearch(source, waiting = Promise.resolve(), recognized = true) {
    const facade = {
      sealAdmission() { calls.push(`seal:${source}`) },
      async quiesceOwned() {
        calls.push(`quiesce:${source}`)
        await waiting
        const value = Object.freeze({ status: 'owned-empty' })
        // Unit-only branded observation; native cleanup is qualified separately.
        if (recognized) accepted.set(value, facade)
        return value
      },
      snapshot() { return {} },
    }
    appShutdown.registerResearch(source, facade, (value, expected) => accepted.get(value) === expected ? value : null)
  }
  registerResearch('owner-host')
  registerResearch('capability')
  let erase
  const sandbox = {
    localDataErased: false, localDataResetInFlight: false, localDataResetRefusal: null,
    auditIdentitySettings: null, appShutdown,
    ipcMain: { handle: (name, callback) => { assert.equal(name, 'mc-reset:erase'); erase = callback } },
    withFleetProfileSender: (event, action) => { assert.equal(event.trusted, true); return action() },
    trustedFleetProfileSender: candidate => candidate === event && candidate.sender === sender,
    app: { getPath: name => { assert.equal(name, 'userData'); return directory } },
    rendererPrefs: prefs,
    mainLagMonitor, heapGuard,
    productDiagnostics: { dispose: async () => {} },
    captureResetBrowserStorage: options => browserStorage.captureResetBrowserStorage({ ...options, timeoutMs: 40 }),
    agentRuntimeStoppedForReset: false,
    nodeRecovery: { stop: () => { calls.push('stop-recovery'); return Promise.resolve() } },
    agentHost: { closeAll: async () => { calls.push('close-agents') } },
    removeAgentEventListener: null, agentSessions: new Map(),
    capabilityLayerStarting: Promise.resolve(),
    relaySupervisor: { stop: async () => { calls.push('stop-relay'); return { ok: true, stopped: true } } },
    relayFacadeCredentials: {}, agentFacade: { close: async () => { calls.push('close-facade') } },
    closeCanonicalLedger: async () => { calls.push('close-ledger'); return { ok: true, closed: true } },
    path,
    resolveCapabilityRoot: () => directory,
    require: module => {
      assert.equal(module, join(directory, 'src', 'lib', 'state-store.js'))
      return { sealAndCloseStateStore: () => { calls.push('close-state'); return { ok: true, closed: true } } }
    },
    capabilityLayer: null, capabilityLayerChild: null, capabilityLayerStatus: null,
    stopCapabilityLayer: (child, options) => {
      calls.push('stop-child')
      assert.equal(options.requireExit, true)
      return capabilityLayer.stopCapabilityLayer(child, { ...options, timeoutMs: 30, reapTree() {} })
    },
    stopAgentResources: () => { calls.push('stop-resources') },
    appOwnedOwnerHost: { close: async () => { calls.push('close-authority') } },
    agentSessionAuthority: {}, ownerHostStatus: null,
    stopAppOwnedOwnerHost: (host, options) => {
      assert.equal(options.requireClose, true)
      return capabilityLayer.stopAppOwnedOwnerHost(host, options)
    },
    localDataResetPlan: () => { calls.push('measure'); return { ok: true, roots: [{ kind: 'user-data', guarded: true, present: true, directory }] } },
    eraseLocalData: () => { calls.push('sweep'); rmSync(directory, { recursive: true }); return { complete: true } },
    ...overrides,
  }
  const accounts = installAccountResetFixture(sandbox, directory, accountOptions)
  const closeAccounts = sandbox.closeAccountWritersForReset
  sandbox.closeAccountWritersForReset = options => { calls.push('close-accounts'); return closeAccounts(options) }
  Object.assign(sandbox, overrides)
  vm.runInNewContext(between("ipcMain.handle('mc-reset:erase'", '/* Two ways to get the bootstrap proof'), sandbox)
  return { sandbox, calls, sentinel, directory, prefs, sender, event, accounts, registerResearch, tickDiagnostics, erase: () => erase(event) }
}

function assertNoSweep(f, reply) {
  assert.equal(reply.ok, false)
  assert.equal(reply.restartRequired, true)
  assert.equal(reply.code, 'RESET_RUNTIME_QUIESCE_UNCONFIRMED')
  assert.equal(f.calls.includes('measure'), false)
  assert.equal(f.calls.includes('sweep'), false)
  assert.equal(f.sandbox.localDataErased, false)
  assert.equal(readFileSync(f.sentinel, 'utf8'), 'retained until every runtime holder is confirmed stopped')
}

test('actual reset refuses a bounded nonexited child without sweeping or losing its cleanup handles', { timeout: 8000 }, async t => {
  const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); process.send('ready')"], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  })
  const nativeKill = child.kill.bind(child)
  t.after(async () => {
    child.kill = nativeKill
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2000) })
    nativeKill('SIGKILL')
    await exited
  })
  await once(child, 'message', { signal: AbortSignal.timeout(3000) })
  // Fault the signal-delivery seam while retaining an actual live child.
  child.kill = () => true
  const f = resetFixture(t, { capabilityLayer: { child }, capabilityLayerChild: child })
  const starting = f.sandbox.capabilityLayerStarting
  const authority = f.sandbox.appOwnedOwnerHost
  const reply = await f.erase()
  assertNoSweep(f, reply)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(f.sandbox.capabilityLayer.child, child)
  assert.equal(f.sandbox.capabilityLayerChild, child)
  assert.equal(f.sandbox.capabilityLayerStarting, starting)
  assert.equal(f.sandbox.appOwnedOwnerHost, authority)
  const count = f.calls.length
  assert.equal(await f.erase(), reply, 'an unconfirmed cleanup requires restart before another erase attempt')
  assert.equal(f.calls.length, count)
})

test('actual reset waits for independent research with zero agents and rejects an unrecognized observation', async t => {
  const waiting = deferred()
  const f = resetFixture(t)
  f.registerResearch('capability', waiting.promise, false)
  const resetting = f.erase()
  for (let count = 0; count < 12; count++) await Promise.resolve()
  assert.equal(f.sandbox.agentSessions.size, 0)
  assert.equal(f.calls.includes('quiesce:capability'), true)
  assert.equal(f.calls.includes('close-ledger'), false)
  assert.equal(f.calls.includes('measure'), false)
  waiting.resolve()
  assertNoSweep(f, await resetting)
})

for (const phase of ['agents', 'relay', 'facade', 'ledger', 'authority', 'state', 'state-refusal', 'lag', 'lag-refusal', 'heap', 'heap-refusal']) test(`actual reset refuses unconfirmed ${phase} cleanup before measuring or sweeping`, async t => {
  const fail = () => { throw new Error(`fixture ${phase} close failed`) }
  const overrides = {
    agents: { agentHost: { closeAll: fail } },
    relay: { relaySupervisor: { stop: async () => ({ ok: false, stopped: false }) } },
    facade: { agentFacade: { close: fail } },
    ledger: { closeCanonicalLedger: async () => ({ ok: false, closed: false }) },
    authority: { appOwnedOwnerHost: { close: fail } },
    state: { require: () => ({ sealAndCloseStateStore: fail }) },
    'state-refusal': { require: () => ({ sealAndCloseStateStore: () => ({ ok: false, closed: false }) }) },
    lag: { mainLagMonitor: { sealForErase: fail } },
    'lag-refusal': { mainLagMonitor: { sealForErase: () => ({ ok: true, sealed: false }) } },
    heap: { heapGuard: { sealForErase: fail } },
    'heap-refusal': { heapGuard: { sealForErase: () => ({ ok: true, sealed: false }) } },
  }
  const f = resetFixture(t, overrides[phase])
  const host = f.sandbox.agentHost, authority = f.sandbox.appOwnedOwnerHost
  assertNoSweep(f, await f.erase())
  if (phase === 'agents') assert.equal(f.sandbox.agentHost, host, 'retain failed session cleanup for ordinary close')
  if (['agents', 'relay', 'facade', 'ledger', 'authority'].includes(phase)) assert.equal(f.sandbox.appOwnedOwnerHost, authority)
  const count = f.calls.length
  assertNoSweep(f, await f.erase())
  assert.equal(f.calls.length, count, 'an unconfirmed close cannot become success on retry')
})

test('a late research facade invalidates actual reset cleanup before measurement and sweep', async t => {
  const waiting = deferred()
  const f = resetFixture(t)
  f.sandbox.appOwnedOwnerHost.close = () => { f.registerResearch('owner-host', waiting.promise) }
  assertNoSweep(f, await f.erase())
  waiting.resolve()
})

test('actual reset serializes attempts while retaining the closing agent host', async t => {
  const waiting = deferred()
  const f = resetFixture(t, { agentHost: { closeAll: () => waiting.promise } })
  const host = f.sandbox.agentHost
  const first = f.erase()
  assert.equal(f.sandbox.agentHost, host, 'ordinary shutdown retains the pending cleanup owner')
  assert.equal((await f.erase()).code, 'RESET_IN_PROGRESS')
  assert.equal(f.calls.includes('measure'), false)
  waiting.resolve()
  assert.equal((await first).ok, true)
  assert.equal(f.calls.filter(call => call === 'sweep').length, 1)
})

test('actual reset drains an admitted account action before closing the ledger or deleting data', async t => {
  const f = resetFixture(t), action = deferred(), entered = deferred()
  f.sandbox.accountMutations.add(action.promise)
  const close = f.sandbox.closeAccountWritersForReset
  f.sandbox.closeAccountWritersForReset = options => { entered.resolve(); return close(options) }
  const resetting = f.erase()
  assert.equal(f.sandbox.accountResetStarted, true)
  await entered.promise
  assert.equal(f.calls.includes('close-ledger'), false)
  assert.equal(f.calls.includes('measure'), false)
  assert.equal(existsSync(f.sentinel), true)
  action.resolve({ ok: false, code: 'ACCOUNT_RESET_STARTED' })
  const answer = await resetting
  assert.equal(answer.ok, true)
  assert.equal(answer.accountsClosed.localQuiesced, true)
  assert.equal(f.accounts.store.current().signedIn, false)
})

test('actual reset latches an unconfirmed account action drain and retains its cleanup ownership', async t => {
  const f = resetFixture(t), action = deferred()
  f.sandbox.accountMutations.add(action.promise)
  const close = f.sandbox.closeAccountWritersForReset
  f.sandbox.closeAccountWritersForReset = () => close({ timeoutMs: 20 })
  assertNoSweep(f, await f.erase())
  assert.equal(f.sandbox.accountMutations.has(action.promise), true)
  assert.equal(f.calls.includes('close-ledger'), false)
  action.resolve()
  await Promise.resolve()
  assertNoSweep(f, await f.erase())
})

test('actual reset permits erase after confirmed local cleanup while reporting remote revocation refusal', async t => {
  const requested = []
  const f = resetFixture(t, {}, { fetchImpl: async (url, options) => {
    // A closed response seam, not an external request. Both the controller and
    // its local account files are real, including the selected hosted session.
    const route = new URL(url).pathname
    requested.push([route, options.method])
    if (route === '/v1/desktop/sessions' && options.method === 'POST') {
      return new Response(JSON.stringify({ account: { id: 'erase-hosted-fixture', email: 'erase@example.invalid' } }), {
        status: 200,
        headers: { 'set-cookie': `__Host-te_desktop=${'a'.repeat(48)}; Secure; HttpOnly; Path=/; Expires=${new Date(Date.now() + 3600000).toUTCString()}` },
      })
    }
    assert.equal(route, '/v1/desktop/sessions/all')
    assert.equal(options.method, 'DELETE')
    return new Response('{}', { status: 503 })
  } })
  assert.equal((await f.accounts.controller.signIn({ username: 'erase@example.invalid', password: 'synthetic fixture' })).ok, true)
  const reply = await f.erase()
  assert.equal(reply.ok, true)
  assert.equal(reply.revoked.ok, false)
  assert.equal(reply.swept.complete, true)
  assert.equal(reply.stateClosed.ok, true)
  assert.equal(reply.stateClosed.closed, true)
  assert.equal(existsSync(f.sentinel), false)
  assert.ok(f.calls.indexOf('measure') > f.calls.indexOf('close-authority'))
  assert.ok(f.calls.indexOf('close-state') > f.calls.indexOf('close-authority'))
  assert.ok(f.calls.indexOf('measure') > f.calls.indexOf('close-state'))
  assert.deepEqual(reply.browserStorage, { attempted: true, cleared: true })
  assertOrdered(f.calls.join('\n'), ['close-state', 'measure', 'seal-prefs', 'clear-browser', 'measure', 'sweep'])
  assert.deepEqual(requested, [['/v1/desktop/sessions', 'POST'], ['/v1/desktop/sessions/all', 'DELETE']])
})

test('actual reset can erase an unreadable signed-out account record after sealing its store', async t => {
  const f = resetFixture(t)
  writeFileSync(join(f.directory, 'product-accounts.json'), '{unreadable fixture account record')
  const answer = await f.erase()
  assert.equal(answer.ok, true)
  assert.equal(answer.accountsClosed.localQuiesced, true)
  assert.equal(answer.revoked.revokedSessions, false, 'the fixture never held a session to revoke')
  assert.equal(existsSync(f.directory), false)
})

for (const problem of ['missing', 'null-path', 'foreign-path', 'throwing-path']) test(`actual reset refuses ${problem} browser Session ownership without clearing or sweeping`, async t => {
  const f = resetFixture(t)
  if (problem === 'missing') f.sender.session = null
  if (problem === 'null-path') f.sender.session.storagePath = null
  if (problem === 'foreign-path') f.sender.session.storagePath = join(f.directory, 'another-partition')
  if (problem === 'throwing-path') Object.defineProperty(f.sender.session, 'storagePath', { get() { throw new Error('fixture storage getter failed') } })
  const answer = await f.erase()
  assert.equal(answer.ok, false)
  assert.equal(answer.restartRequired, true)
  assert.equal(answer.browserStorage.attempted, false)
  assert.equal(answer.browserStorage.cleared, false)
  assert.equal(f.calls.includes('clear-browser'), false)
  assert.equal(f.calls.includes('sweep'), false)
  assert.equal(f.sandbox.localDataErased, false)
  assert.equal(existsSync(f.sentinel), true)
})

function pausedBrowser(f) {
  const entered = deferred(), completion = deferred()
  f.sender.session.clearStorageData = options => {
    assert.deepEqual(options, { storages: ['localstorage'] })
    f.calls.push('clear-browser')
    entered.resolve()
    return completion.promise
  }
  return { entered, completion }
}

test('actual reset seals both live diagnostic writers before browser clearing and prevents delayed log resurrection', async t => {
  const f = resetFixture(t)
  f.tickDiagnostics()
  const files = ['main-lag.log', 'main-heap.log'].map(name => join(f.directory, name))
  const before = files.map(file => readFileSync(file))
  const paused = pausedBrowser(f)
  const resetting = f.erase()
  await paused.entered.promise
  f.tickDiagnostics()
  assert.equal(f.sandbox.mainLagMonitor.start(), false)
  assert.equal(f.sandbox.heapGuard.start(), false)
  for (let i = 0; i < files.length; i += 1) assert.deepEqual(readFileSync(files[i]), before[i])
  paused.completion.resolve()
  assert.equal((await resetting).ok, true)
  f.tickDiagnostics()
  f.sandbox.heapGuard.check()
  assert.equal(existsSync(f.directory), false, 'queued diagnostics cannot recreate the swept profile')
})

test('actual reset seals retained prefs and shell writers while browser deletion is pending, then remeasures before sweeping', async t => {
  const f = resetFixture(t)
  assert.equal(f.prefs.set('retained', 'before erase').ok, true)
  const bytes = readFileSync(f.prefs.file)
  const paused = pausedBrowser(f)
  const clearing = f.erase()
  await paused.entered.promise
  assert.equal(f.sandbox.localDataErased, true)
  assert.equal(f.prefs.set('late-write', 'must not persist').error.code, 'MC_PREFS_ERASED')
  assert.deepEqual(readFileSync(f.prefs.file), bytes)
  assert.equal(f.calls.filter(call => call === 'measure').length, 1)
  assert.equal(f.calls.includes('sweep'), false)
  assert.equal((await f.erase()).code, 'RESET_IN_PROGRESS')
  paused.completion.resolve()
  const answer = await clearing
  assert.equal(answer.ok, true)
  assert.equal(answer.browserStorage.cleared, true)
  assert.equal(f.calls.filter(call => call === 'measure').length, 2)
  assert.equal(f.calls.filter(call => call === 'sweep').length, 1)
  assert.equal(f.prefs.set('after erase', 'must not recreate').error.code, 'MC_PREFS_ERASED')
  assert.equal(existsSync(f.directory), false)
})

for (const change of ['research', 'sender', 'session', 'directory', 'browser-hardlink', 'plan']) test(`actual reset refuses a post-clear ${change} change with truthful browser completion and no disk sweep`, async t => {
  const f = resetFixture(t)
  const paused = pausedBrowser(f)
  const clearing = f.erase()
  await paused.entered.promise
  if (change === 'research') f.registerResearch('owner-host')
  if (change === 'sender') f.sandbox.trustedFleetProfileSender = () => false
  if (change === 'session') f.sender.session = { ...f.sender.session }
  if (change === 'directory') {
    const moved = `${f.directory}-moved`
    fs.renameSync(f.directory, moved)
    fs.mkdirSync(f.directory)
    t.after(() => rmSync(moved, { recursive: true, force: true }))
  }
  if (change === 'browser-hardlink') {
    const local = join(f.directory, 'Local Storage')
    fs.mkdirSync(local)
    fs.linkSync(f.sentinel, join(local, 'shared-file'))
  }
  if (change === 'plan') f.sandbox.localDataResetPlan = () => ({ ok: true, roots: [] })
  paused.completion.resolve()
  const answer = await clearing
  assert.equal(answer.ok, false)
  assert.equal(answer.restartRequired, true)
  assert.equal(answer.browserStorage.attempted, true)
  assert.equal(answer.browserStorage.cleared, true)
  assert.match(answer.reason, /Browser settings were cleared/)
  assert.doesNotMatch(answer.reason, /Nothing was deleted/)
  assert.equal(Object.hasOwn(answer, 'swept'), false)
  assert.equal(f.calls.includes('sweep'), false)
  const count = f.calls.length
  assert.equal(await f.erase(), answer)
  assert.equal(f.calls.length, count, 'late invalidation must latch refusal before a same-process retry')
})

for (const failure of ['throw', 'reject', 'timeout']) test(`actual reset reports attempted browser ${failure} honestly and refuses sweep/retry`, async t => {
  const f = resetFixture(t)
  const paused = deferred()
  f.sender.session.clearStorageData = () => {
    f.calls.push('clear-browser')
    if (failure === 'throw') throw new Error('fixture clear failed')
    if (failure === 'reject') return Promise.reject(new Error('fixture clear failed'))
    return paused.promise
  }
  const answer = await f.erase()
  assert.equal(answer.ok, false)
  assert.equal(answer.restartRequired, true)
  assert.equal(answer.browserStorage.attempted, true)
  assert.equal(answer.browserStorage.cleared, false)
  assert.match(answer.reason, /removal was attempted/)
  assert.doesNotMatch(answer.reason, /Nothing was deleted/)
  assert.equal(f.calls.includes('sweep'), false)
  assert.equal(Object.hasOwn(answer, 'swept'), false)
  assert.equal(existsSync(f.sentinel), true)
  paused.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(answer.browserStorage.cleared, false, 'late completion must not rewrite the refusal')
  const count = f.calls.length
  assert.equal(await f.erase(), answer)
  assert.equal(f.calls.length, count)
})

test('a filesystem sweep that throws after deleting a file preserves browser facts and latches an uncertain result', async t => {
  const f = resetFixture(t)
  f.sandbox.eraseLocalData = () => {
    f.calls.push('sweep')
    fs.unlinkSync(f.sentinel)
    throw new Error('fixture sweep failed after partial deletion')
  }
  const answer = await f.erase()
  assert.equal(answer.ok, false)
  assert.equal(answer.restartRequired, true)
  assert.equal(answer.browserStorage.attempted, true)
  assert.equal(answer.browserStorage.cleared, true)
  assert.equal(Object.hasOwn(answer, 'swept'), false)
  assert.match(answer.reason, /File removal was attempted; its result is unconfirmed/)
  assert.doesNotMatch(answer.reason, /Nothing was deleted|remaining files were not swept/)
  assert.equal(existsSync(f.sentinel), false)
  const count = f.calls.length
  assert.equal(await f.erase(), answer)
  assert.equal(f.calls.length, count)
})

test('actual reset refuses an audit maintenance flight before stopping any runtime', async t => {
  const f = resetFixture(t, { auditIdentitySettings: { isBusy: () => true } })
  const reply = await f.erase()
  assert.equal(reply.code, 'AUDIT_MAINTENANCE_REQUIRED')
  assert.equal(f.calls.length, 0)
  assert.equal(existsSync(f.sentinel), true)
})

test('a stale host and a readiness continuation both refuse after reset', async () => {
  const buildSource = between('async function buildAgentHost()', '/* Every Start that lands while the owner host')
  const buildSandbox = {
    auditIdentitySettings: null,
    appShutdown: { started: false },
    agentRuntimeStoppedForReset: true,
    agentHost: Object.freeze({ stale: true }),
    capabilityLayerStarting: null,
    agentSessionAuthority: null,
    ownerHostStatus: {},
    createAgentHost() { throw new Error('createAgentHost must not run after reset') },
  }
  vm.createContext(buildSandbox)
  vm.runInContext(`${buildSource}\nglobalThis.buildAgentHost = buildAgentHost`, buildSandbox)
  await assert.rejects(
    buildSandbox.buildAgentHost(),
    error => error?.code === 'AGENT_RUNTIME_STOPPED_FOR_RESET',
  )

  let releaseReadiness
  buildSandbox.agentRuntimeStoppedForReset = false
  buildSandbox.agentHost = null
  buildSandbox.capabilityLayerStarting = new Promise(resolve => { releaseReadiness = resolve })
  const pending = buildSandbox.buildAgentHost()
  buildSandbox.agentRuntimeStoppedForReset = true
  releaseReadiness()
  await assert.rejects(
    pending,
    error => error?.code === 'AGENT_RUNTIME_STOPPED_FOR_RESET',
    'a build already awaiting readiness must not revive the host after reset',
  )

  const getSource = between('function getAgentHost()', '/* ---------- the agent and organisation channels')
  const getSandbox = {
    auditIdentitySettings: null,
    appShutdown: { started: false },
    agentRuntimeStoppedForReset: true,
    agentHost: Object.freeze({ stale: true }),
    buildAgentHostOnce() { throw new Error('the builder must not run after reset') },
  }
  vm.createContext(getSandbox)
  vm.runInContext(`${getSource}\nglobalThis.getAgentHost = getAgentHost`, getSandbox)
  await assert.rejects(
    getSandbox.getAgentHost(),
    error => error?.code === 'AGENT_RUNTIME_STOPPED_FOR_RESET',
    'the terminal gate must win even if a stale host reference somehow remains',
  )
})

test('a facade listen crossing reset drops its bearer and cannot start the relay', async () => {
  const facadeSource = between('let relayFacadeCredentials = null', 'const relaySupervisor = createRelaySupervisor')
  let resolveListen
  let closes = 0
  let listens = 0
  const connectionTicket = Object.freeze({})
  const sandbox = {
    appShutdown: { started: false },
    agentRuntimeStoppedForReset: false,
    // Model an enrolled connection whose fence stays current across local reset.
    // The reset flag itself must reject the pending bearer.
    remoteConnectionFence: {
      ticket: () => connectionTicket,
      isCurrent: ticket => ticket === connectionTicket,
    },
    relayMachineIsEnrolled: () => true,
    agentFacade: {
      listen() {
        listens += 1
        return new Promise(resolve => { resolveListen = resolve })
      },
      async close() { closes += 1 },
    },
    getAgentCommandSurface() { throw new Error('facade already exists') },
    console: { error() {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(
    `${facadeSource}\nglobalThis.armRelayFacade = armRelayFacade; globalThis.facadeCredentials = () => relayFacadeCredentials`,
    sandbox,
  )

  const arming = sandbox.armRelayFacade()
  assert.equal(listens, 1, 'arming must reach listen before reset crosses it')
  assert.equal(typeof resolveListen, 'function')
  sandbox.agentRuntimeStoppedForReset = true
  resolveListen({ origin: 'http://127.0.0.1:1', token: 'must-not-survive' })
  assert.equal(await arming, false)
  assert.equal(sandbox.facadeCredentials(), null)
  assert.equal(closes, 1)

  assert.equal(await sandbox.armRelayFacade(), false)
  assert.equal(listens, 1, 'a post-reset arm must refuse before calling listen again')

  // Positive control: the same fixture can publish credentials without reset.
  sandbox.agentRuntimeStoppedForReset = false
  const allowedArming = sandbox.armRelayFacade()
  const credentials = { origin: 'http://127.0.0.1:1', token: 'fixture-only' }
  assert.equal(listens, 2)
  resolveListen(credentials)
  assert.equal(await allowedArming, true)
  assert.equal(sandbox.facadeCredentials(), credentials)
  assert.equal(closes, 1, 'a successful arm must not close the facade')

  const poll = between("ipcMain.handle('mc-device-claim:poll'", "ipcMain.handle('mc-device-claim:cancel'")
  assert.match(poll, /return remoteConnection\.poll\(\)/,
    'claim polling must delegate to the connection lifecycle')
  const connection = between('const remoteConnection = createRemoteConnectionLifecycle({', '/* THE THREE CHANNELS THE CONNECT SCREEN DRIVES')
  assert.match(connection, /onConnected: async \(\) => \{\s*if \(await armRelayFacade\(\)\) relaySupervisor\.start\(\)/,
    'a refused facade arm must not start the relay child')
  const startup = between('function startSupervisedCapabilityLayer()', '/* THE ANSWER EVERY READER OF THE LAYER')
  assert.match(startup, /if \(agentRuntimeStoppedForReset\)[\s\S]*CAPABILITY_STOPPED_FOR_RESET/,
    'future capability starts must refuse after reset')
  assert.match(startup, /if \(await armRelayFacade\(\)\) relaySupervisor\.start\(\)/,
    'startup must not create the relay child when reset wins the facade race')
})
