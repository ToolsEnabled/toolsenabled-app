import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import capabilityLayer from '../../shell/capability-layer.cjs'

const {
  childEnvironment,
  guiEnvironment,
  readCapabilityProof,
  readPayloadRecord,
  resolveCapabilityRoot,
  startAppOwnedOwnerHost,
  startCapabilityLayer,
  stopAppOwnedOwnerHost,
  stopCapabilityLayer,
} = capabilityLayer

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

/* A stand-in for the spawned capability layer: an object with the two streams
 * and the two events the supervisor listens to, and nothing else. Using a fake
 * rather than a real process keeps these tests hermetic -- the real thing
 * binds a port in the 4610-4619 range, and this machine has a live bridge in
 * that range whose token files a second instance would rewrite. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => { child.exitCode = 0 }
  return child
}

test('the child runs on the Electron binary in Node mode', () => {
  const environment = childEnvironment({ PATH: 'x' })
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(environment.PATH, 'x')
})

/* THIS IS A REGRESSION GUARD, NOT A TAUTOLOGY. An inherited
 * ELECTRON_RUN_AS_NODE turns the GUI binary into a headless Node that exits 0
 * with no output and no window. That produced a "silent exit" which was
 * diagnosed twice, wrongly, as a product defect -- once as a missing entry
 * point in the archive -- before anyone read the environment. Any harness that
 * launches the packaged app must strip it, so the strip lives in code with a
 * test on it rather than in a person's memory. */
test('an environment prepared for the GUI process carries no Node-mode variable', () => {
  const environment = guiEnvironment({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: 'x' })
  assert.equal('ELECTRON_RUN_AS_NODE' in environment, false)
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in environment, false)
  assert.equal(environment.PATH, 'x')
})

test('the payload is located beside the app before it is looked for in a checkout', () => {
  const seen = []
  const resourcesPath = join(tmpdir(), 'packaged', 'resources')
  const repoRoot = join(tmpdir(), 'checkout')
  const root = resolveCapabilityRoot({
    resourcesPath,
    repoRoot,
    exists: (candidate) => { seen.push(candidate); return true },
  })
  assert.equal(root, join(resourcesPath, 'capability'), 'the packaged payload must win when both locations exist')
  assert.equal(seen.length, 1, 'payload discovery must stop after finding the packaged payload')
})

test('no payload anywhere resolves to nothing rather than to a guess', () => {
  const root = resolveCapabilityRoot({ resourcesPath: 'R:\\resources', repoRoot: 'C:\\checkout', exists: () => false })
  assert.equal(root, null)
})

test('a payload record without a bridge entrypoint is refused', () => {
  const result = readPayloadRecord('R:\\capability', { readFileSync: () => JSON.stringify({ schemaVersion: 1 }) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CAPABILITY_PAYLOAD_INVALID')
})

test('an unreadable payload record is refused rather than treated as absent', () => {
  const result = readPayloadRecord('R:\\capability', { readFileSync: () => { throw new Error('ENOENT') } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CAPABILITY_PAYLOAD_UNREADABLE')
})

/* The whole point of this lane: a build that ships the viewer alone must say
 * so in those words, not fail somewhere downstream as a bridge timeout. */
test('a build with no capability payload names that as the problem', async () => {
  const result = await startCapabilityLayer({ root: null, origin: 'http://127.0.0.1:4601', workspaceRoot: 'W:\\ws' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CAPABILITY_PAYLOAD_ABSENT')
  assert.match(result.reason, /viewer alone/)
})

test('the listening address and proof file are taken from the layer, not assumed', async (t) => {
  const child = fakeChild()
  const root = mkdtempSync(join(tmpdir(), 'capability-layer-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify({
    bridgeEntrypoint: 'bridge.cjs',
    ownerHostModule: 'src/owner-host.js',
    hostModules: ['src/owner-host.js'],
  }))
  writeFileSync(join(root, 'bridge.cjs'), '')
  let spawnedWith = null
  const pending = startCapabilityLayer({
    root,
    origin: 'http://127.0.0.1:4603',
    workspaceRoot: 'W:\\ws',
    execPath: 'R:\\app\\ToolsEnabled.exe',
    env: {},
    spawn: (execPath, args, options) => { spawnedWith = { execPath, args, options }; return child },
  })

  child.stdout.emit('data', `${JSON.stringify({
    ok: true,
    baseUrl: 'http://127.0.0.1:4612',
    port: 4612,
    pid: 4242,
    bootstrapProofFile: 'R:\\capability\\state\\proof.json',
  })}\n`)
  const result = await pending
  assert.equal(result.ok, true, 'a valid payload fixture must reach the startup announcement')
  assert.equal(result.baseUrl, 'http://127.0.0.1:4612', 'the announced listening address must be returned')
  assert.equal(result.port, 4612, 'the announced port must be returned')
  assert.equal(result.bootstrapProofFile, 'R:\\capability\\state\\proof.json', 'the announced proof file must be returned')
  assert.equal(spawnedWith.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.ok(spawnedWith.args.includes('--origin'))
  assert.ok(spawnedWith.args.includes('http://127.0.0.1:4603'))
})

for (const cancelVersion of [null, 1, 2]) test(`the app retains private session authority with cancel version ${cancelVersion}`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'owner-host-layer-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify({
    bridgeEntrypoint: 'bridge.cjs',
    ownerHostModule: 'src/owner-host.js',
    hostModules: ['src/owner-host.js'],
  }))
  writeFileSync(join(root, 'bridge.cjs'), '')
  writeFileSync(join(root, 'src', 'owner-host.js'), `
    'use strict'
    exports.createOwnerHost = () => ({
      pipeName: '\\\\\\\\.\\\\pipe\\\\ToolsEnabled.OwnerHost.V2.fixture',
      generation: '00000000-0000-4000-8000-000000000000',
      listening: false,
      closed: false,
      async listen() { this.listening = true },
      async close() { this.closed = true },
      bindSession(value) { return { bound: true, credential: 'opaque', value } },
      revokeSession(value) { return value.credential === 'opaque' },
      assertSession(value) { return { valid: value.credential === 'opaque' } },
      cancelVersion: ${JSON.stringify(cancelVersion)},
      cancelSessionWork(value) { return { cancelled: value.sessionId } },
      resumeSessionWork(value) { return { resumed: value.sessionId } },
    })
  `)

  const started = await startAppOwnedOwnerHost({ root })
  assert.equal(started.ok, true)
  assert.equal(started.host.listening, true)
  assert.equal(started.authority.bind({ sessionId: 'one' }).credential, 'opaque')
  assert.equal(started.authority.revoke({ credential: 'opaque' }), true)
  assert.deepEqual(started.authority.assert({ credential: 'opaque' }), { valid: true })
  if (cancelVersion === 2) {
    assert.equal(started.authority.cancelVersion, 2)
    assert.deepEqual(started.authority.cancelWork({ sessionId: 'one' }), { cancelled: 'one' })
    assert.deepEqual(started.authority.resumeWork({ sessionId: 'one' }), { resumed: 'one' })
  } else {
    assert.equal('cancelWork' in started.authority, false)
    assert.equal('resumeWork' in started.authority, false)
  }
  await stopAppOwnedOwnerHost(started.host)
  assert.equal(started.host.closed, true)
})

test('an app-owned capability child gets its retained private IPC authority before announcing readiness', async t => {
  const root = mkdtempSync(join(tmpdir(), 'capability-resource-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', hostModules: ['src/owner-host.js'] }))
  writeFileSync(join(root, 'bridge.cjs'), '')
  const child = fakeChild()
  let spawned; let attached; let closed = false
  const pending = startCapabilityLayer({ root, origin: 'http://127.0.0.1:4603', workspaceRoot: root, env: {},
    spawn(command, args, options) { spawned = { args, options }; return child },
    resourceChannel: { attach(value) { attached = value; return { close() { closed = true } } } },
  })
  assert.equal(attached, child)
  assert.deepEqual(spawned.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
  assert.deepEqual(spawned.args.slice(-2), ['--resource-channel', 'inherited'])
  assert.deepEqual(Object.keys(spawned.options.env), ['ELECTRON_RUN_AS_NODE'], 'no resource token or grant is an environment variable')
  child.stdout.emit('data', JSON.stringify({ ok: true, baseUrl: 'http://127.0.0.1:4612' }) + '\n')
  assert.equal((await pending).ok, true)
  child.emit('exit', 0)
  assert.equal(closed, true)
})

test('an app resource attachment failure stops that exact capability child and cannot fall back to standalone', async t => {
  const root = mkdtempSync(join(tmpdir(), 'capability-resource-refusal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', hostModules: ['src/owner-host.js'] }))
  writeFileSync(join(root, 'bridge.cjs'), '')
  const child = fakeChild(); let killed = false
  child.kill = () => { killed = true }
  const result = await startCapabilityLayer({ root, origin: 'http://127.0.0.1:4603', workspaceRoot: root, env: {},
    spawn: () => child, resourceChannel: { attach() { throw new Error('Stopped fixture monitor.') } },
  })
  assert.equal(result.ok, false); assert.equal(result.code, 'CAPABILITY_SPAWN_FAILED'); assert.equal(killed, true)
})

function lifecyclePayload(t) {
  const root = mkdtempSync(join(tmpdir(), 'capability-lifecycle-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', hostModules: ['src/owner-host.js'] }))
  writeFileSync(join(root, 'bridge.cjs'), '')
  return root
}

for (const withResources of [false, true]) {
  test(`research lifecycle attaches to the exact child before readiness ${withResources ? 'alongside resources' : 'without a resource channel'}`, async t => {
    const root = lifecyclePayload(t)
    const child = fakeChild()
    const calls = []
    let launch
    const pending = startCapabilityLayer({ root, origin: 'http://127.0.0.1:4603', workspaceRoot: root, env: {},
      spawn(command, args, options) { launch = { args, options }; calls.push('spawn'); return child },
      lifecycleChannel: { attach(value) {
        assert.equal(value, child); calls.push('research')
        return { close() { calls.push('research-close') } }
      } },
      resourceChannel: withResources ? { attach(value) {
        assert.equal(value, child); calls.push('resources')
        return { close() { calls.push('resources-close') } }
      } } : null,
    })
    assert.deepEqual(calls, withResources ? ['spawn', 'research', 'resources'] : ['spawn', 'research'])
    assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
    assert.deepEqual(launch.args.slice(-2), ['--research-lifecycle-channel', 'inherited'])
    assert.equal(launch.args.includes('--resource-channel'), withResources)
    assert.deepEqual(Object.keys(launch.options.env), ['ELECTRON_RUN_AS_NODE'], 'the private protocol has no environment credential')
    child.stdout.emit('data', JSON.stringify({ ok: true, baseUrl: 'http://127.0.0.1:4612' }) + '\n')
    const started = await pending
    assert.equal(started.ok, true)
    assert.equal('researchQuiescence' in started, false, 'startup is not a cleanup observation')
    child.emit('exit', 0)
    assert.equal(calls.filter(value => value === 'research-close').length, 1)
    assert.equal(calls.filter(value => value === 'resources-close').length, withResources ? 1 : 0)
  })
}

test('invalid research attachment refuses before spawning or kills only the child whose attachment failed', async t => {
  const root = lifecyclePayload(t)
  const child = fakeChild()
  let spawns = 0, kills = 0, resources = 0
  child.kill = () => { kills += 1 }
  const options = { root, origin: 'http://127.0.0.1:4603', workspaceRoot: root, env: {},
    spawn() { spawns += 1; return child },
    resourceChannel: { attach() { resources += 1; return { close() {} } } },
  }
  const invalid = await startCapabilityLayer({ ...options, lifecycleChannel: {} })
  assert.equal(invalid.code, 'CAPABILITY_LIFECYCLE_AUTHORITY_REQUIRED')
  assert.equal(spawns, 0)
  for (const attach of [() => { throw new Error('fixture attachment lost') }, () => ({})]) {
    const result = await startCapabilityLayer({ ...options, lifecycleChannel: { attach } })
    assert.equal(result.code, 'CAPABILITY_SPAWN_FAILED')
  }
  assert.equal(spawns, 2)
  assert.equal(kills, 2)
  assert.equal(resources, 0, 'research connection is retained before any neighboring attachment')
})

test('a later resource attachment failure retires the already-retained research connection', async t => {
  const root = lifecyclePayload(t)
  const child = fakeChild()
  const calls = []
  child.kill = () => { calls.push('kill') }
  const result = await startCapabilityLayer({ root, origin: 'http://127.0.0.1:4603', workspaceRoot: root, env: {},
    spawn: () => child,
    lifecycleChannel: { attach: () => ({ close() { calls.push('research-close') } }) },
    resourceChannel: { attach() { throw new Error('fixture resource attachment lost') } },
  })
  assert.equal(result.code, 'CAPABILITY_SPAWN_FAILED')
  assert.deepEqual(calls, ['research-close', 'kill'])
})

test('a malformed bootstrap proof is refused, not passed through', () => {
  const result = readCapabilityProof('R:\\proof.json', { readFileSync: () => JSON.stringify({ token: 'short' }) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CAPABILITY_PROOF_INVALID')
})

test('a well-formed bootstrap proof is returned', () => {
  const result = readCapabilityProof('R:\\proof.json', { readFileSync: () => JSON.stringify({ token: TOKEN }) })
  assert.equal(result.ok, true)
  assert.equal(result.proof, TOKEN)
})

test('a missing proof file is a stated unavailability, not a silent empty value', () => {
  const result = readCapabilityProof(null)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CAPABILITY_PROOF_UNAVAILABLE')
})

/* STOP RESOLVES ON EXIT, NEVER ON A SIGNAL. The local-data reset awaits this
 * and then deletes the state root; a stop that resolved when the escalation
 * timer fired -- before the child had exited -- let the layer's synchronous
 * vault grandchild finish its verb after the sweep and recreate the vault
 * directory (measured 2026-09-02 by uninstall-reset-packaged-qa). */
function killableChild({ exitsOn = 'SIGTERM', pid = 4242 } = {}) {
  const child = fakeChild()
  child.pid = pid
  child.signals = []
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal)
    if (signal === exitsOn) {
      // Exit lands asynchronously, as it does for a real process.
      setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null) }, 15)
    }
    return true
  }
  return child
}

test('stop waits for the real exit before resolving, and reaps the process tree on Windows', async () => {
  const child = killableChild()
  const reaped = []
  let exited = false
  child.once('exit', () => { exited = true })
  await stopCapabilityLayer(child, { timeoutMs: 500, reapTree: (pid) => reaped.push(pid), platform: 'win32' })
  assert.equal(exited, true, 'stop resolved before the child exited')
  assert.deepEqual(child.signals, ['SIGTERM'], 'a child that exits on the first signal must not be SIGKILLed')
  assert.deepEqual(reaped, [4242], 'the orphaned grandchildren are reaped by parent pid once the parent is down')
})

test('a child that ignores the first signal is SIGKILLed, and stop still waits for its exit', async () => {
  const child = killableChild({ exitsOn: 'SIGKILL' })
  const reaped = []
  let exited = false
  child.once('exit', () => { exited = true })
  const started = Date.now()
  await stopCapabilityLayer(child, { timeoutMs: 60, reapTree: (pid) => reaped.push(pid), platform: 'win32' })
  assert.equal(exited, true, 'stop resolved before the SIGKILLed child exited')
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(Date.now() - started >= 60, 'escalation must wait the full timeout before SIGKILL')
  assert.deepEqual(reaped, [4242])
})

test('a child that ignores every signal does not hang the reset forever, and is still reaped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild()
  child.pid = 77
  const signals = []
  child.kill = signal => { signals.push(signal || 'SIGTERM'); return true } // never exits
  const reaped = []
  let settled = false
  const stopped = stopCapabilityLayer(child, { timeoutMs: 30, reapTree: (pid) => reaped.push(pid), platform: 'win32' })
    .then(() => { settled = true })
  assert.deepEqual(signals, ['SIGTERM'])
  t.mock.timers.tick(29)
  assert.deepEqual(signals, ['SIGTERM'], 'no escalation before the first timeout')
  t.mock.timers.tick(1)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  t.mock.timers.tick(59)
  await Promise.resolve()
  assert.equal(settled, false, 'no completion before the third timeout')
  assert.deepEqual(reaped, [])
  t.mock.timers.tick(1)
  await stopped
  assert.equal(settled, true)
  assert.deepEqual(reaped, [77], 'even the no-exit path reaps the tree before resolving')
})

async function actualIdleChild(t) {
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
  return { child, nativeKill }
}

test('audit strict stop accepts an actual retained child only after its exit event', { timeout: 8000 }, async t => {
  const { child } = await actualIdleChild(t)
  let exited = false
  child.once('exit', () => { exited = true })
  await stopCapabilityLayer(child, { timeoutMs: 100, requireExit: true, reapTree() {} })
  assert.equal(exited, true)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('audit strict stop rejects a bounded no-exit deadline while the actual owned child is still alive', { timeout: 8000 }, async t => {
  const { child } = await actualIdleChild(t)
  const signals = []
  // Inject unsuccessful signal delivery, keeping a real retained process alive
  // through the deadline. Cleanup restores its original native kill method.
  child.kill = signal => { signals.push(signal || 'SIGTERM'); return true }
  await assert.rejects(stopCapabilityLayer(child, { timeoutMs: 30, requireExit: true, reapTree() {} }), { code: 'CAPABILITY_STOP_UNCONFIRMED' })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  assert.equal(process.kill(child.pid, 0), true, 'the refusal occurs while the retained test child is actually alive')
})

test('a kill() that throws does not resolve the stop early; the exit is still awaited', async () => {
  const child = fakeChild()
  child.pid = 99
  child.kill = () => { throw new Error('EPERM') }
  let exited = false
  child.once('exit', () => { exited = true })
  setTimeout(() => { child.exitCode = 1; child.emit('exit', 1, null) }, 20)
  await stopCapabilityLayer(child, { timeoutMs: 500, reapTree: () => {}, platform: 'win32' })
  assert.equal(exited, true, 'a throwing kill used to resolve immediately with no exit at all')
})

test('off Windows nothing is reaped; the stop is exit-driven alone', async () => {
  const child = killableChild()
  const reaped = []
  await stopCapabilityLayer(child, { timeoutMs: 500, reapTree: (pid) => reaped.push(pid), platform: 'linux' })
  assert.deepEqual(reaped, [])
})

test('the shell exports the stop it awaits, and the stop never resolves from the escalation timer alone', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../shell/capability-layer.cjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('function stopCapabilityLayer'), source.indexOf('function reapProcessTree'))
  assert.doesNotMatch(body, /SIGKILL'\) \} catch \{[^}]*\}\s*\n\s*resolve\(\)/, 'the SIGKILL timer must not resolve the promise; only exit (or the hard deadline) may')
  assert.match(body, /child\.once\('exit'/, 'the stop must listen for the exit event')
  assert.match(body, /taskkill|reapTree/, 'the stop must reap the tree on Windows')
})
