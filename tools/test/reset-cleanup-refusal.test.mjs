import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { tmpdir, userInfo } from 'node:os'
import { createRequire } from 'node:module'
import { readSweep } from '../../src/account-reset-copy.js'
import { installAccountResetFixture } from './lib/account-reset-fixture.mjs'
import shutdown from '../../shell/research-shutdown.cjs'
const require = createRequire(import.meta.url)
const { stopAppOwnedOwnerHost } = require('../../shell/capability-layer.cjs')
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function between(start, end) {
  const first = main.indexOf(start), last = main.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, `production interval exists: ${start}`)
  return main.slice(first, last)
}
const resetSource = between("ipcMain.handle('mc-reset:erase'", '/* Two ways to get the bootstrap proof')
const senderSource = between('async function withFleetProfileSender(event, action)', '/* Completion comes only')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const cleanupFailure = () => Object.assign(new Error('fixture command cleanup is unconfirmed'), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' })
function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// This executes the production IPC handler and sender/error wrapper. The
// cleanup handles are controlled collaborators; before/after observations use
// real disposable files. Every case refuses before deletion. Successful erase
// and the real guarded sweep are exercised in agent-reset-lifecycle and
// local-data-reset. A refused close is now terminal until restart: retrying
// absent handles must never be mistaken for confirmed quiescence.
function fixture(t) {
  const ownerProfile = userInfo().homedir
  const selectedRoot = process.env.TOOLSENABLED_TEST_ROOT || tmpdir()
  assert.ok(path.isAbsolute(selectedRoot), 'use an absolute owned test root')
  if (process.platform === 'win32') {
    // Resolve the current operating-system account, never a historical
    // fixture profile. Refuse a foreign temporary root before any IO there.
    assert.ok(within(ownerProfile, selectedRoot), 'the fixture must stay inside the current OS account')
    let cursor = ownerProfile
    for (const part of ['', ...path.relative(ownerProfile, selectedRoot).split(path.sep)]) {
      cursor = path.join(cursor, part)
      assert.equal(fs.lstatSync(cursor).isSymbolicLink(), false, 'do not follow another profile through a fixture link')
    }
  }
  const root = fs.realpathSync(selectedRoot)
  const directory = fs.mkdtempSync(path.join(root, 'reset retry '))
  assert.ok(within(root, fs.realpathSync(directory)))
  const dataDirectory = path.join(directory, 'ToolsEnabled fixture')
  fs.mkdirSync(dataDirectory)
  const marker = path.join(dataDirectory, 'retained-data.txt')
  fs.writeFileSync(marker, 'disposable reset fixture\n')
  t.after(() => {
    if (fs.existsSync(directory)) {
      assert.ok(within(root, fs.realpathSync(directory)), 'cleanup remains within the owned fixture root')
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  const controls = { agent: async () => {}, owner: async () => {} }
  const calls = { agents: 0, owners: 0, plans: 0, sweeps: 0, listeners: 0, resources: 0 }
  const agent = { closeAll() { assert.equal(this, agent); calls.agents += 1; return controls.agent() } }
  const owner = { close() { assert.equal(this, owner); calls.owners += 1; return controls.owner() } }
  const authority = Object.freeze({ fixture: 'exact retained session authority' })
  const listener = () => { calls.listeners += 1 }
  const session = Object.freeze({ fixture: 'retained session tracking' })
  const sessions = new Map([['owned-session', session]])
  const sender = { session: Object.freeze({ storagePath: dataDirectory }) }
  const event = { trusted: true, sender }
  const appShutdown = shutdown.createAppShutdownCoordinator({ quit() { assert.fail('reset must keep its result window open') } })
  const accepted = new WeakMap()
  for (const name of ['owner-host', 'capability']) {
    const facade = { sealAdmission() {}, snapshot() { return {} }, async quiesceOwned() {
      const receipt = Object.freeze({ status: 'owned-empty' })
      accepted.set(receipt, facade)
      return receipt
    } }
    appShutdown.registerResearch(name, facade, (receipt, expected) => accepted.get(receipt) === expected ? receipt : null)
  }
  let erase
  const scope = vm.createContext({
    ipcMain: { handle: (channel, handler) => { assert.equal(channel, 'mc-reset:erase'); erase = handler } },
    trustedFleetProfileSender: candidate => candidate === event && candidate.sender === sender,
    fleetFailure: (code, message) => ({ ok: false, error: { code, message } }),
    nodeRecovery: { stop: async () => {} },
    agentRuntimeStoppedForReset: false, localDataErased: false,
    localDataResetInFlight: false, localDataResetRefusal: null, auditIdentitySettings: null,
    appShutdown, app: { getPath: name => { assert.equal(name, 'userData'); return dataDirectory } },
    agentHost: agent, removeAgentEventListener: listener, agentSessions: sessions,
    capabilityLayerStarting: null, capabilityLayer: null, capabilityLayerChild: null, capabilityLayerStatus: null,
    relaySupervisor: { stop: async () => ({ ok: true, stopped: true }) }, relayFacadeCredentials: null, agentFacade: null,
    closeCanonicalLedger: async () => ({ ok: true, closed: true }),
    stopCapabilityLayer: async () => {}, stopAgentResources: () => { calls.resources += 1 },
    appOwnedOwnerHost: owner, agentSessionAuthority: authority, ownerHostStatus: null,
    stopAppOwnedOwnerHost,
    localDataResetPlan() {
      calls.plans += 1
      return { roots: [{ kind: 'user-data', directory: dataDirectory, guarded: true, present: fs.existsSync(dataDirectory) }] }
    },
    eraseLocalData() {
      calls.sweeps += 1
      assert.fail('unconfirmed cleanup must never reach the filesystem sweep')
    },
    console: { error() {} },
  })
  installAccountResetFixture(scope, dataDirectory)
  vm.runInContext(senderSource, scope)
  vm.runInContext(resetSource, scope)
  const untouched = ({ started = true, phase = 'agent' } = {}) => {
    assert.equal(fs.readFileSync(marker, 'utf8'), 'disposable reset fixture\n')
    assert.equal(calls.plans, 0)
    assert.equal(calls.sweeps, 0)
    assert.equal(scope.localDataErased, false)
    assert.equal(scope.agentHost, started && phase === 'owner' ? null : agent, 'only a positively closed agent host may be released')
    assert.equal(scope.appOwnedOwnerHost, owner, 'retain the exact owner-host cleanup handle')
    assert.equal(scope.agentSessionAuthority, authority)
    assert.equal(scope.removeAgentEventListener, started ? null : listener)
    assert.equal(scope.agentSessions.get('owned-session'), started ? undefined : session)
    assert.equal(calls.listeners, started ? 1 : 0, 'new event ingress is detached before waiting for cleanup')
    assert.equal(calls.resources, started && phase === 'owner' ? 1 : 0)
    assert.equal(scope.agentRuntimeStoppedForReset, started)
    assert.equal(scope.accountResetStarted, started)
  }
  const retryRefused = async (reply, phase) => {
    const before = { ...calls }
    assert.equal(await erase(event), reply, 'the exact terminal refusal must survive every same-process retry')
    assert.deepEqual(calls, before, 'retry cannot start cleanup again or reinterpret missing handles as proof')
    untouched({ phase })
  }
  return { scope, calls, controls, untouched, retryRefused, erase: () => erase(event),
    untrusted: () => erase({ trusted: false }) }
}

for (const failing of ['agent', 'owner']) test(`rejected ${failing} cleanup preserves data and unresolved custody until restart`, async t => {
  const f = fixture(t)
  f.controls[failing] = async () => { throw cleanupFailure() }
  const reply = await f.erase()
  assert.equal(reply.ok, false, 'a rejected cleanup must never acknowledge a completed reset')
  assert.equal(reply.code, 'RESET_RUNTIME_QUIESCE_UNCONFIRMED')
  assert.equal(reply.restartRequired, true)
  assert.match(reply.reason, /Nothing was deleted/)
  const shown = readSweep(reply)
  assert.equal(shown.ran, false)
  assert.equal(shown.complete, false)
  assert.equal(shown.reason, reply.reason, 'the actual reset result reader displays the cleanup refusal')
  assert.equal(f.scope.agentRuntimeStoppedForReset, true, 'new work remains fenced during retry')
  f.untouched({ phase: failing })
  assert.equal(f.calls.agents, 1)
  assert.equal(f.calls.owners, failing === 'owner' ? 1 : 0)
  f.controls[failing] = async () => {}
  await f.retryRefused(reply, failing)
})

for (const waiting of ['agent', 'owner']) test(`pending ${waiting} cleanup retains custody and blocks erase until it settles`, async t => {
  const f = fixture(t)
  const gate = deferred()
  f.controls[waiting] = () => gate.promise
  const pending = f.erase()
  t.after(() => gate.resolve())
  await tick()
  f.untouched({ phase: waiting })
  const repeated = await f.erase()
  assert.equal(repeated.code, 'RESET_IN_PROGRESS')
  gate.reject(cleanupFailure())
  const reply = await pending
  assert.equal(reply.ok, false)
  f.untouched({ phase: waiting })
  f.controls[waiting] = async () => {}
  await f.retryRefused(reply, waiting)
})

test('a synchronous owner-host close refusal also survives the shared stop helper', async t => {
  const f = fixture(t)
  f.controls.owner = () => { throw cleanupFailure() }
  const reply = await f.erase()
  assert.equal(reply.ok, false)
  f.untouched({ phase: 'owner' })
  f.controls.owner = async () => {}
  await f.retryRefused(reply, 'owner')
})

test('an untrusted reset cannot start cleanup or touch its data', async t => {
  const f = fixture(t)
  assert.equal((await f.untrusted()).error.code, 'MC_FLEET_PROFILE_SENDER_REFUSED')
  assert.equal(f.calls.agents, 0)
  assert.equal(f.calls.owners, 0)
  f.untouched({ started: false })
  assert.equal(f.scope.localDataResetRefusal, null, 'an untrusted request cannot latch the runtime reset')
})
