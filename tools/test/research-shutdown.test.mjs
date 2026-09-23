import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import shutdown from '../../shell/research-shutdown.cjs'
import appQuit from '../../shell/app-shutdown.cjs'
import auditIdentity from '../../shell/audit-identity-settings.cjs'

const { createAppShutdownCoordinator } = shutdown
const { createAppQuitGate } = appQuit
const flush = async () => { for (let count = 0; count < 8; count += 1) await Promise.resolve() }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(overrides = {}) {
  const calls = []
  const timers = new Set()
  const accepted = new WeakMap()
  const reader = (value, expectedFacade) => accepted.get(value) === expectedFacade ? value : null
  const observation = (status = 'owned-empty') => {
    // A unit fixture, not native cleanup proof. The real engine reader brands
    // only internally produced observations from original owned handles/IPC.
    const value = Object.freeze({ version: 1, status, scope: Object.freeze({ runtimeInstanceId: `fixture-${calls.length}` }) })
    accepted.set(value, null)
    return value
  }
  const coordinator = createAppShutdownCoordinator({
    quit() { calls.push('quit') },
    onBegin() { calls.push('begin') },
    closeAgents() { calls.push('agents') },
    onComplete(result) { calls.push('complete'); fixtureResult = result },
    schedule(callback) { timers.add(callback); return callback },
    unschedule(callback) { timers.delete(callback) },
    makeRequestId: () => 'fixture-request',
    ...overrides,
  })
  let fixtureResult = null
  const facade = (label, result = observation()) => {
    const retained = {
      sealAdmission() { calls.push(`seal:${label}`); return { admissionSealed: true } },
      quiesceOwned(args) {
        calls.push(`quiesce:${label}`)
        assert.equal(args.requestId, 'fixture-request')
        return Promise.resolve(result).then(value => {
          if (accepted.has(value) && accepted.get(value) === null) accepted.set(value, retained)
          return value
        })
      },
      snapshot() { return {} },
    }
    return retained
  }
  const event = () => ({ preventDefault() { calls.push('prevent') } })
  return { coordinator, calls, timers, facade, reader, observation, event,
    result: () => fixtureResult, expire: () => { for (const callback of [...timers]) callback() } }
}

test('research-only exit seals both owned facades before closing agents or awaiting either result', async () => {
  const f = fixture()
  const local = deferred(), remote = deferred()
  f.coordinator.registerResearch('owner-host', f.facade('owner', local.promise), f.reader)
  f.coordinator.registerResearch('capability', f.facade('child', remote.promise), f.reader)
  const waiting = f.coordinator.beforeQuit(f.event())
  assert.equal(f.coordinator.started, true)
  assert.deepEqual(f.calls.slice(0, 7), ['prevent', 'seal:owner', 'seal:child', 'quiesce:owner', 'quiesce:child', 'begin', 'agents'])
  local.resolve(f.observation())
  await flush()
  assert.equal(f.calls.includes('quit'), false, 'one process cannot certify the other')
  remote.resolve(f.observation())
  const result = await waiting
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.research.map(entry => entry.observation.status), ['owned-empty', 'owned-empty'])
  assert.equal(f.calls.filter(call => call === 'quit').length, 1)
  assert.equal(f.timers.size, 0)
})

test('repeated before-quit requests share one flight and completed re-entry is allowed to exit', async () => {
  const ending = deferred()
  const f = fixture({ closeAgents: () => ending.promise })
  const first = f.coordinator.beforeQuit(f.event())
  assert.equal(f.coordinator.beforeQuit(f.event()), first)
  assert.equal(f.calls.filter(call => call === 'begin').length, 1)
  ending.resolve()
  await first
  const count = f.calls.length
  assert.equal(f.coordinator.beforeQuit(f.event()), undefined)
  assert.equal(f.calls.length, count)
})

test('maintenance drains both research facades without quitting and later quit retains their authentic observations', async () => {
  const f = fixture(), owner = deferred(), child = deferred()
  const local = f.facade('owner', owner.promise), remote = f.facade('child', child.promise)
  f.coordinator.registerResearch('owner-host', local, f.reader)
  f.coordinator.registerResearch('capability', remote, f.reader)
  const waiting = f.coordinator.quiesceResearch()
  assert.equal(f.coordinator.quiesceResearch(), waiting)
  assert.equal(f.coordinator.started, false)
  assert.deepEqual(f.calls, ['seal:owner', 'seal:child', 'quiesce:owner', 'quiesce:child'])
  let done = false
  waiting.then(() => { done = true })
  owner.resolve(f.observation())
  await flush()
  assert.equal(done, false)
  child.resolve(f.observation())
  const observed = await waiting
  assert.equal(observed.ok, true)
  assert.equal(f.calls.includes('quit'), false)
  remote.quiesceOwned = () => { throw new Error('The bridge was stopped after its proven drain.') }
  const closed = await f.coordinator.beforeQuit(f.event())
  assert.deepEqual(closed.research, observed.research)
  assert.equal(f.calls.filter(call => call === 'quiesce:child').length, 1)
  assert.equal(f.timers.size, 0)
})

test('maintenance cannot use missing, copied or timed-out research observations as cleanup', async () => {
  const missing = fixture()
  assert.equal((await missing.coordinator.quiesceResearch()).ok, false)
  const f = fixture(), child = deferred()
  f.coordinator.registerResearch('owner-host', f.facade('owner', { ...f.observation() }), f.reader)
  f.coordinator.registerResearch('capability', f.facade('child', child.promise), f.reader)
  const waiting = f.coordinator.quiesceResearch()
  f.expire()
  const result = await waiting
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  child.resolve(f.observation())
  await flush()
  assert.equal(await f.coordinator.quiesceResearch(), result, 'late replies cannot rewrite a refused maintenance receipt')
  assert.equal(f.calls.includes('quit'), false)
})

test('research registered during a maintenance drain is sealed and joins the bounded wait', async () => {
  const f = fixture(), owner = deferred(), late = deferred()
  f.coordinator.registerResearch('owner-host', f.facade('owner', owner.promise), f.reader)
  f.coordinator.registerResearch('capability', f.facade('first'), f.reader)
  const waiting = f.coordinator.quiesceResearch()
  f.coordinator.registerResearch('capability', f.facade('late', late.promise), f.reader)
  assert.ok(f.calls.includes('seal:late'))
  owner.resolve(f.observation())
  await flush()
  let done = false
  waiting.then(() => { done = true })
  await flush()
  assert.equal(done, false)
  late.resolve(f.observation())
  const observed = await waiting
  assert.equal(observed.ok, true)
  assert.equal(observed.research.length, 3)
})

test('a newly registered facade invalidates a completed maintenance receipt until its own drain is confirmed', async () => {
  const f = fixture(), late = deferred()
  f.coordinator.registerResearch('owner-host', f.facade('owner'), f.reader)
  f.coordinator.registerResearch('capability', f.facade('first'), f.reader)
  const first = await f.coordinator.quiesceResearch()
  assert.equal(f.coordinator.researchQuiesced(first), true)
  f.coordinator.registerResearch('capability', f.facade('late', late.promise), f.reader)
  assert.equal(f.coordinator.researchQuiesced(first), false)
  assert.ok(f.calls.includes('seal:late'))
  const waiting = f.coordinator.quiesceResearch()
  let done = false
  waiting.then(() => { done = true })
  await flush()
  assert.equal(done, false)
  late.resolve(f.observation())
  const current = await waiting
  assert.equal(current.ok, true)
  assert.equal(f.coordinator.researchQuiesced(current), true)
  assert.equal(f.coordinator.researchQuiesced(first), false)
})

function auditMaintenanceFixture(f, { childStop = async () => {}, afterQuiesce = () => {} } = {}) {
  const child = { pid: 4242, exitCode: null, signalCode: null }
  const authority = { sessionBindings: new Map() }
  const starting = Promise.resolve()
  const sandbox = {
    CAPABILITY_STATE_ROOT: '/disposable-audit-fixture',
    agentRuntimeStoppedForReset: false,
    agentSessions: new Map(),
    agentHost: { activeSessionCount: () => 0, closeAll: async () => f.calls.push('close-agents') },
    appOwnedOwnerHost: authority, agentSessionAuthority: {},
    capabilityLayer: { child }, capabilityLayerChild: child, capabilityLayerStarting: starting,
    capabilityLayerStatus: {}, ownerHostStatus: {}, removeAgentEventListener: null,
    appShutdown: f.coordinator, shell: { openPath: async () => '' },
    closeCanonicalLedger: async () => { f.calls.push('close-ledger'); return { ok: true } },
    stopCapabilityLayer: async (held, options) => {
      assert.equal(held, child)
      assert.equal(options.requireExit, true)
      f.calls.push('stop-child')
      await childStop(held)
    },
    stopAgentResources: () => f.calls.push('stop-resources'),
    stopAppOwnedOwnerHost: async held => { assert.equal(held, authority); f.calls.push('stop-owner') },
    require(name) {
      assert.equal(name, './audit-identity-settings.cjs')
      return { createAuditIdentitySettings: options => auditIdentity.createAuditIdentitySettings({ ...options,
        quiesce: async () => { const observed = await options.quiesce(); afterQuiesce(); return observed },
        run: async operation => {
          if (operation === 'probe') return { ok: true, canRepair: true, fingerprint: 'same-broken-audit' }
          assert.equal(operation, 'repair')
          f.calls.push('repair')
          return { ok: true, status: 'repaired', restartRequired: true }
        },
      }) }
    },
  }
  vm.runInNewContext(mainBetween("auditIdentitySettings = require('./audit-identity-settings.cjs')", "ipcMain.handle('mc-settings:audit-probe'"), sandbox)
  return { sandbox, child, authority, starting, broker: sandbox.auditIdentitySettings }
}

test('actual audit main wiring drains active research with zero chat agents before closing its ledger or replacing identity', async () => {
  const f = fixture(), owner = deferred(), child = deferred()
  f.coordinator.registerResearch('owner-host', f.facade('active-owner-research', owner.promise), f.reader)
  f.coordinator.registerResearch('capability', f.facade('active-child-research', child.promise), f.reader)
  const { sandbox, broker } = auditMaintenanceFixture(f)
  assert.equal(sandbox.agentSessions.size, 0)
  assert.equal(sandbox.agentHost.activeSessionCount(), 0)
  assert.equal(sandbox.appOwnedOwnerHost.sessionBindings.size, 0)
  const code = await broker.confirmation({ operation: 'repair' }, 1)
  const waiting = broker.rotate(code, 1)
  await flush()
  assert.ok(f.calls.includes('quiesce:active-owner-research'))
  assert.ok(f.calls.includes('quiesce:active-child-research'))
  assert.equal(f.calls.includes('close-ledger'), false)
  assert.equal(f.calls.includes('repair'), false)
  owner.resolve(f.observation())
  await flush()
  assert.equal(f.calls.includes('repair'), false)
  child.resolve(f.observation())
  assert.equal((await waiting).status, 'repaired')
  assert.ok(f.calls.indexOf('close-ledger') > f.calls.indexOf('quiesce:active-child-research'))
  assert.ok(f.calls.indexOf('repair') > f.calls.indexOf('stop-child'))
  assert.ok(f.calls.indexOf('repair') > f.calls.indexOf('stop-owner'))
  assert.equal(sandbox.capabilityLayerChild, null)
  assert.equal(broker.isBusy(), true)
})

test('unconfirmed research cleanup refuses actual audit main wiring before any ledger or identity change and latches restart', async () => {
  const f = fixture()
  f.coordinator.registerResearch('owner-host', f.facade('owner'), f.reader)
  f.coordinator.registerResearch('capability', f.facade('unknown-child', { status: 'owned-empty' }), f.reader)
  const { sandbox, child, broker } = auditMaintenanceFixture(f)
  const result = await broker.rotate(await broker.confirmation({ operation: 'repair' }, 1), 1)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AUDIT_REKEY_RESEARCH_UNCONFIRMED')
  assert.equal(result.restartRequired, true)
  assert.equal(f.calls.includes('close-ledger'), false)
  assert.equal(f.calls.includes('repair'), false)
  assert.equal(sandbox.capabilityLayerChild, child)
  assert.equal(broker.isBusy(), true)
})

test('unconfirmed child exit retains the actual audit main ownership references and never replaces identity', async () => {
  const f = fixture()
  f.coordinator.registerResearch('owner-host', f.facade('owner'), f.reader)
  f.coordinator.registerResearch('capability', f.facade('child'), f.reader)
  const { sandbox, child, authority, starting, broker } = auditMaintenanceFixture(f, {
    childStop: async () => { throw Object.assign(new Error('No exit event'), { code: 'CAPABILITY_STOP_UNCONFIRMED' }) },
  })
  const result = await broker.rotate(await broker.confirmation({ operation: 'repair' }, 1), 1)
  assert.equal(result.ok, false)
  assert.equal(result.restartRequired, true)
  assert.equal(f.calls.includes('repair'), false)
  assert.equal(sandbox.capabilityLayer.child, child)
  assert.equal(sandbox.capabilityLayerChild, child)
  assert.equal(sandbox.capabilityLayerStarting, starting)
  assert.equal(sandbox.appOwnedOwnerHost, authority)
  assert.equal(broker.isBusy(), true)
  assert.equal((await broker.confirmation({ operation: 'repair' }, 1)).ok, false)
})

for (const point of ['child-stop', 'broker-resume']) test(`a late research generation at ${point} cannot use an older cleanup receipt to replace audit identity`, async () => {
  const f = fixture(), late = deferred()
  f.coordinator.registerResearch('owner-host', f.facade('owner'), f.reader)
  f.coordinator.registerResearch('capability', f.facade('first-child'), f.reader)
  const register = () => f.coordinator.registerResearch('capability', f.facade('late', late.promise), f.reader)
  const { broker } = auditMaintenanceFixture(f, point === 'child-stop' ? { childStop: register } : { afterQuiesce: register })
  const result = await broker.rotate(await broker.confirmation({ operation: 'repair' }, 1), 1)
  assert.equal(result.ok, false)
  assert.equal(result.restartRequired, true)
  assert.equal(f.calls.includes('repair'), false)
  assert.ok(f.calls.includes('seal:late'))
  assert.equal(broker.isBusy(), true)
  late.resolve(f.observation())
  await flush()
})

test('a retained research reader invalidated during teardown cannot authorize audit identity replacement', async () => {
  const f = fixture()
  let valid = true
  const reader = (value, facade) => valid ? f.reader(value, facade) : null
  f.coordinator.registerResearch('owner-host', f.facade('owner'), reader)
  f.coordinator.registerResearch('capability', f.facade('child'), reader)
  const { broker } = auditMaintenanceFixture(f, { childStop: () => { valid = false } })
  const result = await broker.rotate(await broker.confirmation({ operation: 'repair' }, 1), 1)
  assert.equal(result.ok, false)
  assert.equal(result.restartRequired, true)
  assert.equal(f.calls.includes('repair'), false)
})

test('missing facades and a throwing close never become stopped proof or prevent owner exit', async () => {
  const f = fixture({ closeAgents() { throw new Error('cannot close') } })
  const result = await f.coordinator.beforeQuit(f.event())
  assert.equal(result.agents, 'unknown')
  assert.deepEqual(result.research.map(entry => entry.observation.status), ['unknown', 'unknown'])
  assert.equal(f.calls.includes('quit'), true)
})

test('the bounded wait permits exit but a late cleanup reply cannot rewrite UNKNOWN', async () => {
  const ending = deferred(), child = deferred()
  const f = fixture({ closeAgents: () => ending.promise })
  f.coordinator.registerResearch('capability', f.facade('child', child.promise), f.reader)
  const waiting = f.coordinator.beforeQuit(f.event())
  f.expire()
  const result = await waiting
  assert.equal(result.timedOut, true)
  assert.equal(result.agents, 'unknown')
  assert.equal(result.research[1].observation.reasonCode, 'RESEARCH_QUIESCE_TIMEOUT')
  child.resolve(f.observation()); ending.resolve()
  await flush()
  assert.equal(f.coordinator.snapshot(), result)
  assert.equal(result.research[1].observation.status, 'unknown')
  assert.equal(f.calls.filter(call => call === 'quit').length, 1)
})

test('an arbitrary or copied positive object is not recognized by the retained engine reader', async () => {
  const f = fixture()
  f.coordinator.registerResearch('owner-host', f.facade('owner', { ...f.observation() }), f.reader)
  f.coordinator.registerResearch('capability', f.facade('child', { ok: true, activeProcesses: 0 }), f.reader)
  const result = await f.coordinator.beforeQuit(f.event())
  assert.deepEqual(result.research.map(entry => entry.observation.reasonCode), ['RESEARCH_QUIESCE_UNRECOGNIZED', 'RESEARCH_QUIESCE_UNRECOGNIZED'])
})

test('a genuine observation issued to another facade is not this retained facade\'s result', async () => {
  const f = fixture()
  const other = f.facade('different-generation')
  const genuineOtherResult = await other.quiesceOwned({ requestId: 'fixture-request' })
  assert.equal(f.reader(genuineOtherResult, other), genuineOtherResult)
  f.coordinator.registerResearch('capability', f.facade('current', genuineOtherResult), f.reader)
  const result = await f.coordinator.beforeQuit(f.event())
  assert.equal(result.research[1].observation.reasonCode, 'RESEARCH_QUIESCE_UNRECOGNIZED')
})

test('remote local-seal acknowledgement alone is not cleanup and a disconnect stays UNKNOWN', async () => {
  const f = fixture()
  const disconnected = Object.assign(new Error('private channel closed'), { code: 'RESEARCH_CHANNEL_CLOSED' })
  f.coordinator.registerResearch('capability', f.facade('child', Promise.reject(disconnected)), f.reader)
  const result = await f.coordinator.beforeQuit(f.event())
  assert.equal(result.research[1].observation.status, 'unknown')
  assert.equal(result.research[1].observation.reasonCode, 'RESEARCH_CHANNEL_CLOSED')
})

test('late facade registration is sealed immediately and joins the still-bounded flight', async () => {
  const agents = deferred(), child = deferred()
  const f = fixture({ closeAgents: () => agents.promise })
  const waiting = f.coordinator.beforeQuit(f.event())
  f.coordinator.registerResearch('capability', f.facade('late', child.promise), f.reader)
  assert.ok(f.calls.includes('seal:late'))
  agents.resolve()
  await flush()
  assert.equal(f.calls.includes('quit'), false)
  child.resolve(f.observation('not-started-in-epoch'))
  const result = await waiting
  assert.equal(result.research[1].observation.status, 'not-started-in-epoch')
})

test('a replacement facade cannot discard an older generation still waiting to stop', async () => {
  const old = deferred()
  const f = fixture()
  f.coordinator.registerResearch('capability', f.facade('old', old.promise), f.reader)
  f.coordinator.registerResearch('capability', f.facade('new'), f.reader)
  const waiting = f.coordinator.beforeQuit(f.event())
  await flush()
  assert.equal(f.calls.includes('quit'), false)
  old.resolve(f.observation())
  const result = await waiting
  assert.equal(result.research.filter(entry => entry.source === 'capability').length, 2)
})

test('a facade arriving after timeout is still sealed but cannot rewrite the completed observation', async () => {
  const agents = deferred()
  const f = fixture({ closeAgents: () => agents.promise })
  const waiting = f.coordinator.beforeQuit(f.event())
  f.expire()
  const result = await waiting
  f.coordinator.registerResearch('capability', f.facade('too-late'), f.reader)
  await flush()
  assert.ok(f.calls.includes('seal:too-late'))
  assert.equal(f.coordinator.snapshot(), result)
  assert.equal(result.research[1].observation.status, 'unknown')
})

test('the actual shell before-quit join does not skip research when there is no chat-agent host', async () => {
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  // Other independent before-quit listeners may appear earlier in the shell.
  // Execute the actual research coordinator registration, with its real callback.
  //
  // Anchor on the gate's CONSTRUCTION and take the whole statement that
  // registers it, not one line. This used to slice a single line matching
  // `app.on('before-quit', createAppQuitGate(`, which stopped matching when
  // T180 wrapped the registration to write a durable exit record first. That
  // is a better shell, and a test that reads one spelling calls it a
  // regression -- so the exit record is asserted below rather than dodged.
  const start = source.indexOf('const appQuitGate = createAppQuitGate(')
  const registration = source.indexOf("app.on('before-quit'", start)
  const end = source.indexOf('\n})', registration)
  assert.ok(start >= 0 && registration > start && end > registration,
    'the shell quit-gate construction and its before-quit registration could not be isolated')
  const f = fixture()
  let beforeQuit
  const exits = []
  const sandbox = { app: { on(name, callback) { assert.equal(name, 'before-quit'); beforeQuit = callback } },
    appShutdown: f.coordinator, createAppQuitGate, BrowserWindow: { getAllWindows: () => [] },
    exitRecord: { writeExitRecord: (event, reason) => exits.push(`${event}:${reason}`) } }
  vm.runInNewContext(source.slice(start, end + 3), sandbox)
  await beforeQuit(f.event())
  await flush()
  assert.equal(f.coordinator.started, true, 'no chat-agent host must not skip the independent research coordinator')
  assert.equal(f.calls.includes('quit'), true)
  // The durable exit record is written by this listener, before the gate runs.
  assert.deepEqual(exits, ['before-quit:app-quit-gate'])
})

test('a registration during synchronous shutdown setup requests its one retained cleanup only once', async () => {
  let f
  f = fixture({ onBegin() { f.coordinator.registerResearch('capability', f.facade('during-begin'), f.reader) } })
  const result = await f.coordinator.beforeQuit(f.event())
  assert.equal(result.research[1].observation.status, 'owned-empty')
  assert.equal(f.calls.filter(value => value === 'quiesce:during-begin').length, 1)
})

const MAIN = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function mainBetween(first, last) {
  const start = MAIN.indexOf(first)
  const end = MAIN.indexOf(last, start + first.length)
  assert.ok(start >= 0 && end > start, `missing main source interval: ${first} .. ${last}`)
  return MAIN.slice(start, end)
}

test('actual agent-host builders refuse stale hosts and continuations after the shutdown fence', async () => {
  const buildSource = mainBetween('async function buildAgentHost()', '/* Every Start that lands while the owner host')
  const getSource = mainBetween('function getAgentHost()', '/* ---------- the agent and organisation channels')
  const ready = deferred()
  const staleHost = Object.freeze({ stale: true })
  const sandbox = {
    appShutdown: { started: false }, agentRuntimeStoppedForReset: false,
    auditIdentitySettings: null,
    agentHost: staleHost, capabilityLayerStarting: ready.promise, agentSessionAuthority: null,
    agentIpcError(code, message) { throw Object.assign(new Error(message), { code }) },
    createAgentHost() { assert.fail('no host may be built after quit') },
    buildAgentHostOnce() { assert.fail('no builder may be selected after quit') },
  }
  vm.runInNewContext(`${buildSource}\n${getSource}\nglobalThis.build = buildAgentHost; globalThis.get = getAgentHost`, sandbox)
  assert.equal(await sandbox.get(), staleHost, 'normal startup keeps the current host')
  sandbox.appShutdown.started = true
  await assert.rejects(sandbox.get(), { code: 'APP_SHUTDOWN_STARTED' })
  await assert.rejects(sandbox.build(), { code: 'APP_SHUTDOWN_STARTED' })
  sandbox.appShutdown.started = false
  sandbox.agentHost = null
  const building = sandbox.build()
  sandbox.appShutdown.started = true
  ready.resolve()
  await assert.rejects(building, { code: 'APP_SHUTDOWN_STARTED' })
})

test('actual relay listen crossing quit cannot publish its newly returned credentials', async () => {
  const listening = deferred()
  let listens = 0, closes = 0
  const sandbox = {
    appShutdown: { started: false }, agentRuntimeStoppedForReset: false,
    remoteConnectionFence: { ticket: () => 1, isCurrent: ticket => ticket === 1 },
    relayMachineIsEnrolled: () => true,
    agentFacade: { listen() { listens += 1; return listening.promise }, async close() { closes += 1 } },
    console: { error() {} },
  }
  const source = mainBetween('let relayFacadeCredentials = null', 'const relaySupervisor = createRelaySupervisor')
  vm.runInNewContext(`${source}\nglobalThis.arm = armRelayFacade; globalThis.credentials = () => relayFacadeCredentials`, sandbox)
  const arming = sandbox.arm()
  assert.equal(listens, 1, 'the enrolled fixture must reach the pending listener before quit')
  sandbox.appShutdown.started = true
  listening.resolve({ origin: 'http://127.0.0.1:1', token: 'fixture-never-used' })
  assert.equal(await arming, false)
  assert.equal(sandbox.credentials(), null)
  assert.equal(closes, 1)
  assert.equal(await sandbox.arm(), false)
  assert.equal(listens, 1)
})

function startupFixture({ ownerResult, capabilityResult, missingLifecycle = false, resourceFailure = null, resourceStatusFailure = null } = {}) {
  const f = fixture()
  const calls = []
  const ownerFacade = f.facade('owner')
  let childFacade
  const resourceAuthority = {
    status() { calls.push('resource-status'); if (resourceStatusFailure) throw resourceStatusFailure; return { bootId: 'fixture-resource-boot' } },
    reserveServiceLane(request, principal) { calls.push('reserve-service'); return { request, principal } },
    onUnavailable(listener) { calls.push('resource-listener'); return listener },
    dispose() { calls.push('resource-dispose') },
  }
  const resources = {
    installResourceHost() { calls.push('resource-install') },
    createAgentResourceHost() { calls.push('resource-create'); if (resourceFailure) throw resourceFailure; return resourceAuthority },
    clearResourceHost() { calls.push('resource-clear') },
    attachResourceAuthority(child, options) { calls.push('resource-attach'); sandbox.resourceOptions = options; return { child, close() {} } },
  }
  const sandbox = {
    path,
    appShutdown: f.coordinator,
    auditIdentitySettings: null,
    agentRuntimeStoppedForReset: false,
    capabilityLayerStarting: null, capabilityLayer: null, capabilityLayerChild: null,
    appOwnedOwnerHost: null, agentSessionAuthority: null, ownerHostStatus: null,
    agentResourceHost: null, agentResourceModule: null, rendererPrefs: {}, agentSessions: new Map(),
    agentOrgRecord: { read: () => ({ ok: true }) },
    requireAgentResourceHost() { if (!sandbox.agentResourceHost) throw new Error('Missing resource authority'); return sandbox.agentResourceHost },
    stopAgentResources() { sandbox.agentResourceHost?.dispose(); sandbox.agentResourceModule?.clearResourceHost(); sandbox.agentResourceHost = null; sandbox.agentResourceModule = null },
    WORKSPACE_ROOT: 'fixture-workspace', CAPABILITY_STATE_ROOT: 'fixture-state', shellOrigin: 'http://127.0.0.1:1',
    researchAppBootId: 'fixture-app-boot', randomUUID: () => 'fixture-connection-generation',
    fs: { mkdirSync() {} },
    resolveCapabilityRoot: () => 'fixture-payload',
    ensureDispatchAssistantConfig: () => ({ ok: true }), refreshChosenAssistantConfig: () => ({ ok: true }),
    console: { error() {} },
    require(modulePath) {
      if (modulePath.endsWith('agent-resource-control.js')) return resources
      if (missingLifecycle) throw new Error('old payload has no lifecycle support')
      if (modulePath.endsWith('lifecycle-channel.js')) return {
        readResearchQuiescenceObservation: f.reader,
        attachResearchLifecycle(child, options) {
          calls.push('attach-child')
          assert.equal(child, sandbox.capabilityLayerChild)
          assert.equal(options.bootId, 'fixture-app-boot')
          assert.equal(options.generation, 'fixture-connection-generation')
          assert.equal('stateIdentity' in options, false, 'the host derives its own fixed state identity')
          childFacade = f.facade('child')
          return Object.assign(childFacade, { close() {} })
        },
      }
      if (modulePath.endsWith('worker-supervisor.js')) return {
        getResearchWorkerSupervisor(...args) {
          assert.equal(args.length, 0, 'the app must retain the shared default registry, not invent a second scope')
          calls.push('retain-owner')
          return ownerFacade
        },
      }
      assert.fail(`unexpected fixture module: ${modulePath}`)
    },
    startAppOwnedOwnerHost() { calls.push('owner-start'); return ownerResult ?? { ok: false, code: 'FIXTURE_OWNER_UNAVAILABLE' } },
    stopAppOwnedOwnerHost(host) { calls.push('owner-stop'); assert.equal(host.fixture, true) },
    startCapabilityLayer(options) {
      calls.push('capability-start')
      sandbox.startOptions = options
      return capabilityResult ?? { ok: false, code: 'FIXTURE_CAPABILITY_UNAVAILABLE' }
    },
    spawnChildProcess() { calls.push('spawn'); return { fixture: true } },
    agentIpcError(code, message) { throw Object.assign(new Error(message), { code }) },
    deviceClaim: { async status() { calls.push('claim-status') } },
    relayMachineIsEnrolled: () => false,
  }
  const source = mainBetween('function startSupervisedCapabilityLayer()', '/* THE ANSWER EVERY READER OF THE LAYER')
  vm.runInNewContext(`${source}\nglobalThis.start = startSupervisedCapabilityLayer`, sandbox)
  return { ...f, calls, sandbox, ownerFacade, resourceAuthority, childFacade: () => childFacade }
}

test('actual startup initializes and verifies resource authority before launching despite failed owner credential hygiene', async () => {
  const f = startupFixture({ ownerResult: { ok: false, code: 'OWNER_HOST_CREDENTIAL_HYGIENE_FAILED' } })
  await f.sandbox.start()
  assert.deepEqual(f.calls, ['retain-owner', 'owner-start', 'resource-install', 'resource-create', 'resource-status', 'capability-start'])
  assert.equal(f.sandbox.ownerHostStatus.code, 'OWNER_HOST_CREDENTIAL_HYGIENE_FAILED')
  assert.equal(f.sandbox.agentSessionAuthority, null)
  assert.equal(f.sandbox.agentResourceHost, f.resourceAuthority, 'retain the initialized monitor for normal cleanup')
  const child = f.sandbox.startOptions.spawn('fixture-command', [], { env: {} })
  f.sandbox.startOptions.lifecycleChannel.attach(child)
  f.sandbox.startOptions.resourceChannel.attach(child)
  assert.equal(f.sandbox.resourceOptions.bootId, 'fixture-resource-boot')
  const request = { provider: 'codex' }, principal = { kind: 'agent-session', sessionId: 'fixture-session' }
  assert.deepEqual(f.sandbox.resourceOptions.reserveLane(request, principal), { request, principal }, 'forward the original principal to the retained authority')
  const result = await f.coordinator.quiesceResearch()
  assert.equal(f.coordinator.researchQuiesced(result), true, 'only the retained unit-branded child/owner replies pass this composition test')
  f.sandbox.stopAgentResources()
  assert.equal(f.calls.includes('resource-dispose'), true)
})

for (const phase of ['construction', 'status']) test(`actual startup refuses unavailable resource ${phase} before spawning and keeps missing research UNKNOWN`, async () => {
  const failure = Object.assign(new Error('Resource authority unavailable'), { code: 'AGENT_RESOURCE_UNKNOWN' })
  const f = startupFixture(phase === 'construction' ? { resourceFailure: failure } : { resourceStatusFailure: failure })
  assert.equal((await f.sandbox.start()).code, 'CAPABILITY_RESOURCE_AUTHORITY_REQUIRED')
  assert.equal(f.calls.includes('capability-start'), false)
  assert.equal(f.calls.includes('spawn'), false)
  assert.equal(f.calls.includes('attach-child'), false)
  assert.equal(f.sandbox.agentResourceHost, null)
  assert.equal(f.calls.includes('resource-clear'), true)
  if (phase === 'status') assert.equal(f.calls.includes('resource-dispose'), true)
  const result = await f.coordinator.quiesceResearch()
  assert.equal(result.ok, false)
  assert.equal(f.coordinator.researchQuiesced(result), false)
  assert.equal(result.research[1].observation.status, 'unknown')
})

test('actual capability startup retains the default DB-free supervisor before owner-host admission and fences a late owner', async () => {
  const owner = deferred()
  const f = startupFixture({ ownerResult: owner.promise })
  const starting = f.sandbox.start()
  assert.deepEqual(f.calls, ['retain-owner', 'owner-start'])
  const closing = f.coordinator.beforeQuit(f.event())
  owner.resolve({ ok: true, host: { fixture: true } })
  assert.equal((await starting).code, 'CAPABILITY_STOPPED_FOR_QUIT')
  assert.equal(f.calls.includes('capability-start'), false)
  assert.equal(f.calls.includes('owner-stop'), true)
  await closing
  assert.equal((await f.sandbox.start()).code, 'CAPABILITY_STOPPED_FOR_QUIT')
  assert.equal(f.calls.filter(value => value === 'owner-start').length, 1)
})

test('actual capability startup binds the exact child facade and keeps it alive until the shutdown join', async () => {
  const capability = deferred()
  const f = startupFixture({ capabilityResult: capability.promise })
  const starting = f.sandbox.start()
  await flush()
  const options = f.sandbox.startOptions
  const child = options.spawn('fixture-command', [], { env: {} })
  assert.equal(f.sandbox.capabilityLayerChild, child)
  const retained = options.lifecycleChannel.attach(child)
  assert.equal(retained, f.childFacade())
  const closing = f.coordinator.beforeQuit(f.event())
  capability.resolve({ ok: true, child })
  assert.equal((await starting).code, 'CAPABILITY_STOPPED_FOR_QUIT')
  assert.equal(f.sandbox.capabilityLayerChild, child, 'the quit join, not a late readiness continuation, owns the child')
  assert.equal(f.calls.includes('claim-status'), false)
  assert.throws(() => options.spawn('fixture-command', [], { env: {} }), { code: 'APP_SHUTDOWN_STARTED' })
  const result = await closing
  assert.equal(result.research[1].observation.status, 'owned-empty')
  assert.equal(f.calls.filter(value => value === 'spawn').length, 1)
})

test('actual failed capability startup retains its exact child for later strict cleanup', async () => {
  const capability = deferred()
  const f = startupFixture({ capabilityResult: capability.promise })
  const starting = f.sandbox.start()
  await flush()
  const options = f.sandbox.startOptions
  const child = options.spawn('fixture-command', [], { env: {} })
  options.lifecycleChannel.attach(child)
  capability.resolve({ ok: false, code: 'CAPABILITY_START_TIMEOUT' })
  assert.equal((await starting).code, 'CAPABILITY_START_TIMEOUT')
  assert.equal(f.sandbox.capabilityLayerChild, child)
  assert.equal(f.calls.includes('claim-status'), false)
})

test('an old payload remains usable but missing lifecycle support cannot produce a positive cleanup observation', async () => {
  const f = startupFixture({ missingLifecycle: true })
  const started = await f.sandbox.start()
  assert.equal(started.code, 'FIXTURE_CAPABILITY_UNAVAILABLE')
  assert.equal(f.calls.includes('capability-start'), true)
  assert.equal(f.sandbox.startOptions.lifecycleChannel, null)
  const result = await f.coordinator.beforeQuit(f.event())
  assert.deepEqual(result.research.map(entry => entry.observation.status), ['unknown', 'unknown'])
})

for (const eventName of ['did-finish-load', 'did-stop-loading']) {
  test(`actual ${eventName} callback cannot re-enable tree commands after quit`, () => {
    const first = `window.webContents.on('${eventName}', () => {`
    const source = mainBetween(first, '\n  })') + '\n  })'
    let handler, ready = 0
    const window = { isDestroyed: () => false, webContents: { on(name, callback) { assert.equal(name, eventName); handler = callback } } }
    const sandbox = { window, win: window, appShutdown: { started: false },
      treeNodeCommandDispatchEnabled: false, treeNodeCommandBroker: { setRendererReady(value) { assert.equal(value, true); ready += 1 } } }
    vm.runInNewContext(source, sandbox)
    handler()
    assert.equal(ready, 1, 'normal loaded windows still admit commands')
    sandbox.treeNodeCommandDispatchEnabled = false
    sandbox.appShutdown.started = true
    handler()
    assert.equal(ready, 1, 'late load must not rearm the disposed broker')
    assert.equal(sandbox.treeNodeCommandDispatchEnabled, false)
  })
}

test('actual window startup cannot resume into another window after quit crosses the server await', async () => {
  const serving = deferred()
  let starts = 0
  // Execute the real pre-construction body. The fixture return marks exactly
  // the point at which the original function would construct BrowserWindow.
  const source = mainBetween('async function createWindow()', '  const window = new BrowserWindow({')
  const sandbox = {
    appShutdown: { started: false }, mirrorUninstallRetention() {}, readState: () => ({}),
    bootTheme: () => 'white', currentWorkAreas: () => [], restoredWindowState: () => ({ theme: 'white' }),
    THEME_SEED: { white: {} }, serveDist: () => serving.promise,
    startSupervisedCapabilityLayer() { starts += 1; return Promise.resolve() },
  }
  vm.runInNewContext(`${source}\nreturn 'window-construction'; }\nglobalThis.create = createWindow`, sandbox)
  const starting = sandbox.create()
  sandbox.appShutdown.started = true
  serving.resolve({ address: () => ({ port: 1 }) })
  assert.equal(await starting, undefined)
  assert.equal(starts, 0)
  assert.equal(await sandbox.create(), undefined, 'later attempts remain fenced')
  assert.equal(starts, 0)
  sandbox.appShutdown.started = false
  assert.equal(await sandbox.create(), 'window-construction', 'normal startup still reaches window construction')
  assert.equal(starts, 1)
})

test('the actual shell joins both research calls and agent records before final capability kill, even if optional voice cleanup throws', async () => {
  const f = fixture()
  const owner = deferred(), child = deferred(), agents = deferred()
  const handlers = new Map()
  const capabilityChild = { kill() { f.calls.push('capability-kill') } }
  const sessions = new Map([['active', { marker: 'original-session' }]])
  const sandbox = {
    app: { on: (name, handler) => handlers.set(name, handler), quit() { f.calls.push('quit'); handlers.get('will-quit')() } },
    createAppQuitGate, BrowserWindow: { getAllWindows: () => [] },
    createAppShutdownCoordinator: options => createAppShutdownCoordinator({ ...options,
      makeRequestId: () => 'fixture-request', schedule: callback => callback, unschedule() {} }),
    voiceHost: { close() { f.calls.push('voice-close'); throw new Error('optional voice service lost') } },
    sandboxSetup: { sealAdmission() { f.calls.push('setup-seal') } }, sandboxSetupExecutor: null,
    nodeRecovery: { async stop() { f.calls.push('recovery-stop') } },
    usageRecorder: { async flush() { f.calls.push('usage-flush') } },
    transcriptCapture: { async shutdown() { f.calls.push('capture-stop') } },
    nodeTranscripts: { async shutdown({ deleteNodes }) {
      assert.equal(typeof deleteNodes, 'function')
      f.calls.push('transcripts-stop')
      return { ok: true, deleted: false }
    } },
    nodePrivacyCleanup: { prepare() {}, complete() { f.calls.push('privacy-complete') } },
    treeNodeCommandDispatchEnabled: true,
    treeNodeCommandBroker: { dispose() { f.calls.push('broker-dispose') } },
    removeAgentEventListener: () => f.calls.push('remove-listener'),
    agentHost: { closeAll() { f.calls.push('agents-close'); return agents.promise } },
    agentSessions: sessions,
    recordSessionEnd(value, id, reason) {
      assert.equal(sessions.get(id), value)
      assert.equal(reason, 'app-shutdown')
      f.calls.push('agent-record')
    },
    console: { error() {} },
    heapGuard: { stop() {} }, capabilityLayer: null, capabilityLayerChild: capabilityChild,
    stopCapabilityLayer(value) { assert.equal(value, capabilityChild); f.calls.push('capability-stop'); return Promise.resolve() },
    stopAgentResources() { f.calls.push('resources-stop') },
    appOwnedOwnerHost: { fixture: true }, agentSessionAuthority: {}, ownerHostStatus: {},
    stopAppOwnedOwnerHost() { f.calls.push('owner-stop'); return Promise.resolve() },
    relaySupervisor: { stop: () => Promise.resolve() }, closeCanonicalLedger: () => Promise.resolve(),
    /* T180's durable exit record is written from the lifted intervals below,
       so this binding has to exist for them to run at all. That is ALL it
       does here: without it the vm throws "exitRecord is not defined" before
       any ordering assertion is reached. The calls are recorded so a reader
       can see them in f.calls, but NOTHING BELOW ASSERTS THEM -- neutralising
       every writeExitRecord call site in shell/main.cjs leaves this case green
       and reddens the before-quit case above, which is where the record's
       content is actually checked. An earlier version of this comment claimed
       a shutdown that stops narrating itself fails here. It does not. */
    exitRecord: { writeExitRecord: (event, reason) => f.calls.push('exit:' + event + ':' + reason) },
  }
  const setup = mainBetween('const appShutdown = createAppShutdownCoordinator({', '/* A local-data erase')
  const before = mainBetween('async function closeAgentSessionsForQuit()', 'wireSingleInstance({')
  const willStart = MAIN.lastIndexOf("app.on('will-quit'")
  const willEnd = MAIN.indexOf("app.on('window-all-closed'", willStart)
  assert.ok(willStart >= 0 && willEnd > willStart)
  vm.runInNewContext(`${setup}\n${before}\n${MAIN.slice(willStart, willEnd)}\nglobalThis.shutdown = appShutdown`, sandbox)
  sandbox.shutdown.registerResearch('owner-host', f.facade('owner', owner.promise), f.reader)
  sandbox.shutdown.registerResearch('capability', f.facade('child', child.promise), f.reader)
  const waiting = handlers.get('before-quit')(f.event())
  assert.equal(sandbox.treeNodeCommandDispatchEnabled, false, 'optional cleanup failure cannot reopen command admission')
  assert.ok(f.calls.indexOf('quiesce:owner') < f.calls.indexOf('broker-dispose'))
  assert.ok(f.calls.indexOf('quiesce:child') < f.calls.indexOf('agent-record'))
  assert.equal(sessions.size, 0)
  assert.equal(f.calls.includes('capability-kill'), false)
  assert.equal(f.calls.includes('resources-stop'), false)
  agents.resolve(); owner.resolve(f.observation())
  await flush()
  assert.equal(f.calls.includes('capability-kill'), false, 'one remaining research runtime still owns the join')
  child.resolve(f.observation())
  await waiting
  assert.ok(f.calls.indexOf('privacy-complete') > f.calls.indexOf('transcripts-stop'))
  assert.ok(f.calls.indexOf('remove-listener') > f.calls.indexOf('privacy-complete'))
  assert.ok(f.calls.indexOf('remove-listener') > f.calls.indexOf('agents-close'))
  assert.ok(f.calls.indexOf('capability-kill') > f.calls.indexOf('remove-listener'))
  assert.equal(sandbox.agentHost, null)
})
