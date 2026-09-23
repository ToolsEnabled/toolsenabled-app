import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import os from 'node:os'
import { randomUUID } from 'node:crypto'
import relaySupervisor from '../../shell/relay-supervisor.cjs'
import rendererPrefs from '../../shell/renderer-prefs.cjs'
import { ownedSpawnFixture } from './device-claim-owned-fixture.mjs'
import {
  WEB_DRIVE_ON as RENDERER_WEB_DRIVE_ON,
  WEB_DRIVE_PREF_KEY as RENDERER_WEB_DRIVE_PREF_KEY,
} from '../../src/device-claim-flow.js'

const {
  INHERITED_ENVIRONMENT_KEYS,
  REASONS,
  REASON_VALUES,
  RESTART_CEILING_MS,
  RESTART_FLOOR_MS,
  STABLE_AFTER_MS,
  STOP_TIMEOUT_MS,
  WEB_DRIVE_ON,
  WEB_DRIVE_PREF_KEY,
  createRelaySupervisor,
  webDriveMayWrite,
} = relaySupervisor

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_FILE = path.join(HERE, '..', '..', 'shell', 'relay-supervisor.cjs')

// Real absolute paths on the host platform; a C: fixture is relative on POSIX.
// The runner pins Windows TEMP to its permitted account before this allocation.
const FIXTURE_PARENT = fs.realpathSync(os.tmpdir())
const FIXTURE_ROOT = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'te-relay-supervisor-'))
after(() => {
  assert.equal(path.dirname(FIXTURE_ROOT), FIXTURE_PARENT)
  assert.equal(fs.realpathSync(FIXTURE_ROOT), FIXTURE_ROOT)
  fs.rmSync(FIXTURE_ROOT, { recursive: true })
  assert.equal(fs.existsSync(FIXTURE_ROOT), false)
})
const PAYLOAD_ROOT = path.join(FIXTURE_ROOT, 'app', 'resources', 'capability')
const RELAY_ENTRY_PATH = path.join(PAYLOAD_ROOT, 'tools', 'relay-shell.js')
const STATE_ROOT = path.join(FIXTURE_ROOT, 'state', 'capability')
const EXEC_PATH = path.join(FIXTURE_ROOT, 'app', 'ToolsEnabled.exe')

const FACADE = Object.freeze({ origin: 'http://127.0.0.1:52341', token: 'facade-token-abcdefghijklmnop' })

/* THE ENVIRONMENT THE PARENT IS ASSUMED TO HAVE, and it is deliberately a
 * hostile one: the provider credentials the payload's own tripwire enumerates,
 * a NODE_OPTIONS that would inject a require into the child, a proxy that
 * would redirect its transport, and a vault redirect that would point it at a
 * second state root. A supervisor that spreads process.env into its child
 * passes every other test in this file and fails the two below. */
const PARENT_ENVIRONMENT = Object.freeze({
  PATH: 'C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT',
  SystemRoot: 'C:\\Windows',
  SystemDrive: 'C:',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  USERPROFILE: 'C:\\Users\\someone',
  TEMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
  TOOLSENABLED_STATE_ROOT: STATE_ROOT,
  /* None of the following may reach the child. */
  ANTHROPIC_API_KEY: 'sk-ant-should-never-cross',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-never-cross',
  OPENAI_API_KEY: 'sk-should-never-cross',
  NODE_OPTIONS: '--require C:\\anything.js',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  TOOLSENABLED_VAULT_PATH: 'D:\\somewhere-else\\secrets.json',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
  ELECTRON_RUN_AS_NODE: '1',
})

const FORBIDDEN_IN_CHILD_ENVIRONMENT = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'NODE_OPTIONS',
  'HTTPS_PROXY',
  'TOOLSENABLED_VAULT_PATH',
  'ELECTRON_NO_ATTACH_CONSOLE',
])

/* A clock and a timer wheel that answer to this test rather than to the
 * machine. Backoff is measured in minutes of wall time; proving it with real
 * sleeps would make this suite the slowest thing in the repository and would
 * still be flaky on a loaded machine. */
function fakeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs
  let nextId = 1
  const pending = new Map()
  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = nextId += 1
      pending.set(id, { fn, at: nowMs + ms, ms })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    /* Fires everything due at or before the new time. A callback that
       schedules another timer does NOT fire in the same advance, which keeps
       each step of a backoff sequence separately observable. */
    advance(ms) {
      nowMs += ms
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= nowMs)
      due.sort((a, b) => a[1].at - b[1].at)
      for (const [id, timer] of due) {
        pending.delete(id)
        timer.fn()
      }
    },
    scheduled: () => [...pending.values()].map((timer) => timer.ms),
    count: () => pending.size,
  }
}

/* A stand-in for the relay child: the two pipes and the two events the
 * supervisor listens to, and nothing else. `exitWith` is what a test uses to
 * end it; `kill` reports whether a stop actually signalled it. */
function fakeChild({ exitOnKill = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal || 'SIGTERM')
    if (exitOnKill) child.exitWith(null, signal || 'SIGTERM')
    return true
  }
  child.exitWith = (code, signal = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
  }
  return child
}

function fakeSpawn({ children = [], onSpawn } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = children[calls.length] || fakeChild()
    calls.push({ command, args, options, child })
    if (onSpawn) onSpawn(calls.length)
    return child
  }
  spawn.calls = calls
  spawn.last = () => calls[calls.length - 1]
  return spawn
}

function supervisorUnderTest(overrides = {}) {
  const clock = overrides.clock || fakeClock()
  const spawn = overrides.spawn || fakeSpawn()
  const logged = []
  const supervisor = createRelaySupervisor({
    spawn,
    resolvePayloadRoot: overrides.resolvePayloadRoot || (() => PAYLOAD_ROOT),
    facade: 'facade' in overrides ? overrides.facade : FACADE,
    isEnrolled: overrides.isEnrolled || (() => true),
    log: (line) => logged.push(line),
    now: clock.now,
    execPath: EXEC_PATH,
    env: overrides.env || PARENT_ENVIRONMENT,
    exists: overrides.exists || ((candidate) => candidate === RELAY_ENTRY_PATH),
    stateRoot: 'stateRoot' in overrides ? overrides.stateRoot : STATE_ROOT,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  return { supervisor, spawn, clock, logged }
}

/* ------------------------------------------------------------------ §2.1 */

test('a supervisor cannot be constructed without the dependencies it needs', () => {
  assert.throws(() => createRelaySupervisor(), TypeError)
  assert.throws(() => createRelaySupervisor({ spawn: () => {}, resolvePayloadRoot: () => '' }), TypeError)
  assert.throws(() => createRelaySupervisor({ spawn: () => {}, isEnrolled: () => false }), TypeError)
})

/* THE MODULE THE ELECTRON MAIN PROCESS OWNS BUT DOES NOT LIVE IN. A require of
   electron here would make the supervisor untestable in this suite and
   unusable from anything but a running app, which is the drift the injected
   seams exist to prevent. */
test('the supervisor never requires electron', () => {
  const source = fs.readFileSync(SUPERVISOR_FILE, 'utf8')
  assert.equal(/require\(\s*['"]electron['"]\s*\)/.test(source), false)
})

/* ------------------------------------------------------------------ §2.2 */

test('start spawns the relay shell out of the staged payload, on the Electron binary', () => {
  const { supervisor, spawn } = supervisorUnderTest()
  const outcome = supervisor.start()
  assert.equal(outcome.ok, true)
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.last().command, EXEC_PATH)
  assert.deepEqual(spawn.last().args, [RELAY_ENTRY_PATH])
  assert.equal(spawn.last().options.windowsHide, true)
  assert.deepEqual(spawn.last().options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
  assert.equal(supervisor.status().running, true)
})

/* THE TEST A WHOLESALE process.env COPY FAILS. The parent environment above
   holds provider credentials, a NODE_OPTIONS injection and a vault redirect;
   the child's environment is asserted by EXACT key set, so anything that
   arrives by inheritance rather than by decision is a red test rather than a
   quiet widening. */
test('the child environment is an exact allowlist, not a copy of the parent', () => {
  const { supervisor, spawn } = supervisorUnderTest()
  supervisor.start()
  const environment = spawn.last().options.env
  assert.deepEqual(Object.keys(environment).sort(), [
    'APPDATA',
    'ComSpec',
    'ELECTRON_RUN_AS_NODE',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'ProgramData',
    'ProgramFiles',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TOOLSENABLED_AGENT_FACADE_ORIGIN',
    'TOOLSENABLED_AGENT_FACADE_TOKEN',
    'TOOLSENABLED_STATE_ROOT',
    'USERPROFILE',
    'windir',
  ].sort())
  for (const forbidden of FORBIDDEN_IN_CHILD_ENVIRONMENT) {
    assert.equal(forbidden in environment, false, `${forbidden} must not reach the relay child`)
  }
  /* Every key that IS there was asked for by name. */
  for (const key of Object.keys(environment)) {
    const declared = INHERITED_ENVIRONMENT_KEYS.includes(key)
      || key === 'ELECTRON_RUN_AS_NODE'
      || key === 'TOOLSENABLED_STATE_ROOT'
      || key === 'TOOLSENABLED_AGENT_FACADE_ORIGIN'
      || key === 'TOOLSENABLED_AGENT_FACADE_TOKEN'
    assert.equal(declared, true, `${key} is in the child environment without being declared`)
  }
})

function shellModuleForPlatform(file, platform, overrides = {}) {
  const localRequire = createRequire(file)
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    process: { platform, execPath: process.execPath, env: {} },
    Buffer, setTimeout, clearTimeout,
  })
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
  return module.exports
}

test('Linux enrollment and relay children retain the local GNOME session context', async () => {
  // Exercise both production spawn paths; neither a vault nor a network service
  // is replaced with a success claim. Only the child process is recorded here.
  const linuxRelay = shellModuleForPlatform(SUPERVISOR_FILE, 'linux')
  const claimFile = path.join(HERE, '..', '..', 'shell', 'device-claim.cjs')
  const linuxClaim = shellModuleForPlatform(claimFile, 'linux', {
    './relay-supervisor.cjs': linuxRelay,
  })
  const env = Object.freeze({
    ...PARENT_ENVIRONMENT,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SYSTEM_BUS_ADDRESS: 'tcp:host=attacker.invalid,port=1',
    LD_PRELOAD: '/untrusted.so',
    PYTHONPATH: '/untrusted-python',
  })
  const spawn = fakeSpawn()
  const dependencies = {
    spawn, resolvePayloadRoot: () => PAYLOAD_ROOT, isEnrolled: () => true,
    stateRoot: STATE_ROOT, execPath: EXEC_PATH, env, exists: () => true,
  }
  const supervisor = linuxRelay.createRelaySupervisor(dependencies)
  supervisor.start()
  const claim = linuxClaim.createDeviceClaim({ ...dependencies, spawnOwned: ownedSpawnFixture(spawn) })
  const status = claim.status()
  const claimChild = spawn.last().child
  claimChild.stdout.emit('data', '{"connected":false}\n')
  claimChild.exitWith(0)
  claimChild.emit('close', 0, null)
  assert.equal((await status).ok, true)
  assert.equal(spawn.calls.length, 2)
  for (const call of spawn.calls) {
    assert.equal(call.options.env.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS)
    assert.equal(call.options.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR)
    for (const key of [...FORBIDDEN_IN_CHILD_ENVIRONMENT, 'DBUS_SYSTEM_BUS_ADDRESS', 'LD_PRELOAD', 'PYTHONPATH']) {
      assert.equal(key in call.options.env, false, `${key} crossed into a Linux vault caller`)
    }
  }
  await supervisor.stop()
})

test('Linux session forwarding accepts one local Unix bus and refuses remote or implicit alternatives', () => {
  const linuxRelay = shellModuleForPlatform(SUPERVISOR_FILE, 'linux')
  const build = (address, runtime = '/run/user/1000') => linuxRelay.relayChildEnvironment({
    DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: runtime,
  }, { stateRoot: STATE_ROOT })
  for (const address of [
    'unix:path=/run/user/1000/bus',
    'unix:path=/tmp/a%20private/bus,guid=0123456789abcdef0123456789abcdef',
    'unix:abstract=/tmp/dbus-session,guid=0123456789abcdef0123456789abcdef',
    'unix:guid=0123456789abcdef0123456789abcdef,path=/run/user/1000/bus',
  ]) {
    assert.equal(build(address).DBUS_SESSION_BUS_ADDRESS, address)
  }
  for (const address of [
    '', 'tcp:host=attacker.invalid,port=1234', 'nonce-tcp:host=attacker.invalid',
    'autolaunch:', 'unix:path=/run/user/1000/bus;tcp:host=attacker.invalid,port=1',
    'unixexec:path=/usr/bin/helper', 'unix:path=/tmp/bus,abstract=other',
    'unix:dir=/tmp', 'unix:path=relative', 'unix:path=/run/../tmp/bus',
    'unix:path=/tmp/bus%00suffix', 'unix:abstract=', 'unix:path=/tmp/bus,guid=invalid',
    'unix:path=/tmp/bus%GG', 'unix:path=/tmp/unescaped space', 'unix:path=/tmp/bus\n',
  ]) {
    const output = build(address)
    assert.equal('DBUS_SESSION_BUS_ADDRESS' in output, false, address)
    assert.equal('XDG_RUNTIME_DIR' in output, false, address)
  }
  for (const runtime of ['relative', '/', '/run/user/1000/../other', '/run/user/1000\n']) {
    assert.equal('DBUS_SESSION_BUS_ADDRESS' in build('unix:path=/run/user/1000/bus', runtime), false)
  }
  const withoutRuntime = linuxRelay.relayChildEnvironment({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=private-session' })
  assert.equal(withoutRuntime.DBUS_SESSION_BUS_ADDRESS, 'unix:abstract=private-session')
  assert.equal('XDG_RUNTIME_DIR' in withoutRuntime, false)
})

test('Windows relay children never inherit Linux session lookup fields', () => {
  const windowsRelay = shellModuleForPlatform(SUPERVISOR_FILE, 'win32')
  const output = windowsRelay.relayChildEnvironment({
    ...PARENT_ENVIRONMENT,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
  }, { stateRoot: STATE_ROOT })
  assert.equal('DBUS_SESSION_BUS_ADDRESS' in output, false)
  assert.equal('XDG_RUNTIME_DIR' in output, false)
  assert.equal(output.TOOLSENABLED_STATE_ROOT, STATE_ROOT)
  for (const key of FORBIDDEN_IN_CHILD_ENVIRONMENT) assert.equal(key in output, false)
})

test('the child is told where the state root is, and runs the Electron binary as Node', () => {
  const { supervisor, spawn } = supervisorUnderTest()
  supervisor.start()
  const environment = spawn.last().options.env
  assert.equal(environment.TOOLSENABLED_STATE_ROOT, STATE_ROOT)
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1')
})

test('the facade credentials cross in the environment when there is a facade', () => {
  const { supervisor, spawn } = supervisorUnderTest()
  supervisor.start()
  const environment = spawn.last().options.env
  assert.equal(environment.TOOLSENABLED_AGENT_FACADE_ORIGIN, FACADE.origin)
  assert.equal(environment.TOOLSENABLED_AGENT_FACADE_TOKEN, FACADE.token)
})

/* FAIL CLOSED, BOTH VARIABLES OR NEITHER. A child handed an origin with no
   token would forward with a blank bearer and be refused by the facade in a
   way that reads as a machine fault; the composite bridge's honest
   AGENT_FACADE_ABSENT is the better answer. */
test('a missing or half-present facade sends neither variable', () => {
  for (const facade of [null, undefined, {}, { origin: 'http://127.0.0.1:1' }, { token: 'only-a-token' }, () => { throw new Error('no facade') }]) {
    const { supervisor, spawn } = supervisorUnderTest({ facade })
    supervisor.start()
    const environment = spawn.last().options.env
    assert.equal('TOOLSENABLED_AGENT_FACADE_ORIGIN' in environment, false)
    assert.equal('TOOLSENABLED_AGENT_FACADE_TOKEN' in environment, false)
  }
})

/* The facade mints its bearer per boot and re-hands it if the child is
   respawned, so the credentials are read at spawn time rather than cached at
   construction. */
test('a respawned child is handed the facade credentials current at that moment', () => {
  const clock = fakeClock()
  let issued = { origin: 'http://127.0.0.1:1111', token: 'first-token' }
  const children = [fakeChild(), fakeChild()]
  const spawn = fakeSpawn({ children })
  const { supervisor } = supervisorUnderTest({ clock, spawn, facade: () => issued })
  supervisor.start()
  assert.equal(spawn.calls[0].options.env.TOOLSENABLED_AGENT_FACADE_TOKEN, 'first-token')
  issued = { origin: 'http://127.0.0.1:2222', token: 'second-token' }
  children[0].exitWith(1)
  clock.advance(RESTART_FLOOR_MS)
  assert.equal(spawn.calls.length, 2)
  assert.equal(spawn.calls[1].options.env.TOOLSENABLED_AGENT_FACADE_TOKEN, 'second-token')
  assert.equal(spawn.calls[1].options.env.TOOLSENABLED_AGENT_FACADE_ORIGIN, 'http://127.0.0.1:2222')
})

/* ------------------------------------------------------------------ §2.3 */

test('the facade token is never logged and never reported', () => {
  const { supervisor, logged } = supervisorUnderTest()
  supervisor.start()
  for (const line of logged) assert.equal(line.includes(FACADE.token), false)
  assert.equal(JSON.stringify(supervisor.status()).includes(FACADE.token), false)
})

/* ------------------------------------------------------------- §3.1, §3.2 */

test('a machine with no relay pair recorded starts nothing', () => {
  const { supervisor, spawn } = supervisorUnderTest({ isEnrolled: () => false })
  const outcome = supervisor.start()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, REASONS.NOT_ENROLLED)
  assert.equal(spawn.calls.length, 0)
  assert.equal(supervisor.status().running, false)
  assert.equal(supervisor.status().lastReason, REASONS.NOT_ENROLLED)
})

test('an enrolment predicate that throws is not enrolment', () => {
  const { supervisor, spawn } = supervisorUnderTest({ isEnrolled: () => { throw new Error('vault unreadable') } })
  assert.equal(supervisor.start().code, REASONS.NOT_ENROLLED)
  assert.equal(spawn.calls.length, 0)
})

/* --------------------------------------------- payload and state refusals */

test('a build with no payload, or a payload with no relay leg, says so once', () => {
  const absent = supervisorUnderTest({ resolvePayloadRoot: () => null })
  assert.equal(absent.supervisor.start().code, REASONS.PAYLOAD_ABSENT)
  assert.equal(absent.spawn.calls.length, 0)
  assert.equal(absent.clock.count(), 0)

  const old = supervisorUnderTest({ exists: () => false })
  assert.equal(old.supervisor.start().code, REASONS.ENTRYPOINT_ABSENT)
  assert.equal(old.spawn.calls.length, 0)
  assert.equal(old.clock.count(), 0)
})

test('a state root that is missing or relative is refused rather than resolved', () => {
  const missing = supervisorUnderTest({ stateRoot: '', env: { PATH: 'C:\\Windows\\System32' } })
  assert.equal(missing.supervisor.start().code, REASONS.STATE_ROOT_UNKNOWN)
  assert.equal(missing.spawn.calls.length, 0)

  const relative = supervisorUnderTest({ stateRoot: 'capability' })
  assert.equal(relative.supervisor.start().code, REASONS.STATE_ROOT_UNKNOWN)
  assert.equal(relative.spawn.calls.length, 0)
})

test('the state root is taken from the parent environment when the caller states none', () => {
  const { supervisor, spawn } = supervisorUnderTest({ stateRoot: undefined })
  supervisor.start()
  assert.equal(spawn.last().options.env.TOOLSENABLED_STATE_ROOT, STATE_ROOT)
})

/* ------------------------------------------------------------------ §2.4 */

test('a child that dies is restarted, and not before the floor has passed', () => {
  const clock = fakeClock()
  const children = [fakeChild(), fakeChild()]
  const spawn = fakeSpawn({ children })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  children[0].exitWith(1)
  assert.equal(supervisor.status().running, false)
  assert.equal(supervisor.status().lastReason, REASONS.EXITED_ERROR)
  assert.equal(supervisor.status().lastExitAt, clock.now())

  clock.advance(RESTART_FLOOR_MS - 1)
  assert.equal(spawn.calls.length, 1, 'restarted before the floor')
  clock.advance(1)
  assert.equal(spawn.calls.length, 2)
  assert.equal(supervisor.status().restarts, 1)
  assert.equal(supervisor.status().running, true)
})

/* THE RELAY LOOP IS MEANT TO BE PERMANENT. A leg that exits 0 has still
   stopped answering for this machine, and a supervisor that reads a clean exit
   as "it meant to" is how a computer goes quietly unreachable. */
test('a child that exits cleanly is restarted too', () => {
  const clock = fakeClock()
  const children = [fakeChild(), fakeChild()]
  const spawn = fakeSpawn({ children })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  children[0].exitWith(0)
  assert.equal(supervisor.status().lastReason, REASONS.EXITED_CLEAN)
  clock.advance(RESTART_FLOOR_MS)
  assert.equal(spawn.calls.length, 2)
})

test('the wait doubles from two seconds and stops at a minute', () => {
  const clock = fakeClock()
  const children = Array.from({ length: 9 }, () => fakeChild())
  const spawn = fakeSpawn({ children })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()

  const waits = []
  for (let attempt = 0; attempt < 8; attempt += 1) {
    children[attempt].exitWith(1)
    const [wait] = clock.scheduled()
    waits.push(wait)
    clock.advance(wait)
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000])
  assert.equal(waits[waits.length - 1], RESTART_CEILING_MS)
  assert.equal(supervisor.status().restarts, 8)
})

test('a child that survives a minute earns the floor back', () => {
  const clock = fakeClock()
  const children = Array.from({ length: 5 }, () => fakeChild())
  const spawn = fakeSpawn({ children })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()

  /* Two quick crashes climb the ladder. */
  children[0].exitWith(1)
  clock.advance(2_000)
  children[1].exitWith(1)
  assert.deepEqual(clock.scheduled(), [4_000])
  clock.advance(4_000)

  /* The third child lives a full minute, so its death starts again at two
     seconds rather than at eight. */
  clock.advance(STABLE_AFTER_MS)
  children[2].exitWith(1)
  assert.deepEqual(clock.scheduled(), [RESTART_FLOOR_MS])
  clock.advance(RESTART_FLOOR_MS)
  assert.equal(spawn.calls.length, 4)
})

/* ------------------------------------------------------------------ §2.5 */

test('stop waits for the child to actually exit', async () => {
  const clock = fakeClock()
  const child = fakeChild({ exitOnKill: false })
  const spawn = fakeSpawn({ children: [child] })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()

  let resolved = false
  const stopping = supervisor.stop().then(() => { resolved = true })
  await Promise.resolve()
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(resolved, false, 'stop resolved before the child had exited')

  child.exitWith(null, 'SIGTERM')
  await stopping
  assert.equal(resolved, true)
  assert.equal(supervisor.status().running, false)
})

test('unobserved exit after escalation reports unconfirmed and prevents a replacement leg', async () => {
  const clock = fakeClock()
  const child = fakeChild({ exitOnKill: false })
  const spawn = fakeSpawn({ children: [child] })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  const stopping = supervisor.stop()
  clock.advance(STOP_TIMEOUT_MS)
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(supervisor.status().running, true)
  assert.equal(supervisor.start().ok, false)
  clock.advance(STOP_TIMEOUT_MS)
  assert.deepEqual(await stopping, { ok: false, stopped: false, code: REASONS.STOP_UNCONFIRMED })
  assert.equal(supervisor.status().running, true)
  assert.equal(supervisor.start().ok, false)
  assert.equal(spawn.calls.length, 1)
  child.exitWith(null, 'SIGKILL')
  assert.equal(supervisor.status().running, false)
})

test('nothing is restarted after a stop, including a restart already waiting', async () => {
  const clock = fakeClock()
  const children = [fakeChild(), fakeChild()]
  const spawn = fakeSpawn({ children })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  children[0].exitWith(1)
  assert.equal(clock.count(), 1, 'a restart should be waiting')

  await supervisor.stop()
  assert.equal(clock.count(), 0, 'the waiting restart survived the stop')
  clock.advance(10 * RESTART_CEILING_MS)
  assert.equal(spawn.calls.length, 1)
  assert.equal(supervisor.status().running, false)
})

test('a stopped supervisor stays stopped even if its child exits later', async () => {
  const clock = fakeClock()
  const child = fakeChild({ exitOnKill: false })
  const spawn = fakeSpawn({ children: [child, fakeChild()] })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  const stopping = supervisor.stop()
  child.exitWith(143, null)
  await stopping
  clock.advance(10 * RESTART_CEILING_MS)
  assert.equal(spawn.calls.length, 1)
})

test('start is idempotent: a second call does not put a second leg on the machine', () => {
  const { supervisor, spawn } = supervisorUnderTest()
  supervisor.start()
  const second = supervisor.start()
  assert.equal(second.ok, true)
  assert.equal(second.already, true)
  assert.equal(spawn.calls.length, 1)
})

/* ------------------------------------------------------------------ §2.6 */

test('status answers four facts and nothing else', () => {
  const { supervisor } = supervisorUnderTest()
  const before = supervisor.status()
  assert.deepEqual(Object.keys(before).sort(), ['lastExitAt', 'lastReason', 'restarts', 'running'])
  assert.equal(before.running, false)
  assert.equal(before.restarts, 0)
  assert.equal(before.lastExitAt, null)
  assert.equal(before.lastReason, null)
})

/* WHAT A STATUS SURFACE MUST NEVER BE ABLE TO LEARN FROM THIS MODULE. The
   child below is a badly behaved one: it prints a pair id, a device id, this
   machine's name and an absolute path on both pipes before it dies. None of it
   may appear in status(), because status() is built from the exit and never
   from anything the child said. */
test('status carries no identifiers, whatever the child prints', () => {
  const forbidden = [
    'pair_7f3c9a1b2d4e',
    'device_9911aabbccdd',
    'JOSHS-DESKTOP',
    'C:\\Users\\someone\\AppData\\Roaming\\ToolsEnabled\\capability',
    'wss://toolsenabled.ai/v1/rendezvous',
    'facade-token-abcdefghijklmnop',
  ]
  const clock = fakeClock()
  const child = fakeChild()
  const spawn = fakeSpawn({ children: [child] })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  for (const secret of forbidden) {
    child.stdout.emit('data', Buffer.from(`talking about ${secret}\n`))
    child.stderr.emit('data', Buffer.from(`[relay-shell] failed for ${secret}\n`))
  }
  child.exitWith(1)

  const status = supervisor.status()
  const rendered = JSON.stringify(status)
  for (const secret of forbidden) {
    assert.equal(rendered.includes(secret), false, `status leaked ${secret}`)
  }
  assert.equal(REASON_VALUES.includes(status.lastReason), true)
  assert.equal(typeof status.lastExitAt, 'number')
  assert.equal(typeof status.restarts, 'number')
})

test('every reason a status can carry is a word from the closed set', () => {
  const clock = fakeClock()
  const child = fakeChild()
  const spawn = fakeSpawn({ children: [child, fakeChild()] })
  const { supervisor } = supervisorUnderTest({ clock, spawn })
  supervisor.start()
  child.exitWith(null, 'SIGTERM')
  assert.equal(supervisor.status().lastReason, REASONS.SIGNALLED)
  assert.equal(REASON_VALUES.includes(supervisor.status().lastReason), true)
})

test('a spawn that throws becomes a backed-off retry, not a crash', () => {
  const clock = fakeClock()
  let attempts = 0
  const spawn = (command, args, options) => {
    attempts += 1
    if (attempts === 1) throw new Error(`EACCES ${command} ${JSON.stringify(options.env.TOOLSENABLED_STATE_ROOT)}`)
    return fakeChild()
  }
  spawn.calls = []
  const supervisor = createRelaySupervisor({
    spawn,
    resolvePayloadRoot: () => PAYLOAD_ROOT,
    facade: FACADE,
    isEnrolled: () => true,
    now: clock.now,
    execPath: EXEC_PATH,
    env: PARENT_ENVIRONMENT,
    exists: () => true,
    stateRoot: STATE_ROOT,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  const outcome = supervisor.start()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, REASONS.SPAWN_FAILED)
  /* Nothing exited, so the field that means "when the child last died" is
     still empty -- and the message, which named a path, was dropped. */
  assert.equal(supervisor.status().lastExitAt, null)
  assert.equal(JSON.stringify(supervisor.status()).includes(STATE_ROOT), false)
  clock.advance(RESTART_FLOOR_MS)
  assert.equal(attempts, 2)
  assert.equal(supervisor.status().running, true)
})

test('a spawn that emits an asynchronous error becomes a backed-off retry', () => {
  const clock = fakeClock()
  const failedChild = fakeChild()
  const spawn = fakeSpawn({ children: [failedChild, fakeChild()] })
  const { supervisor } = supervisorUnderTest({ clock, spawn, stateRoot: path.resolve('test-state') })

  assert.equal(supervisor.start().ok, true)
  failedChild.emit('error', new Error('ENOENT'))

  assert.equal(supervisor.status().running, false)
  assert.equal(supervisor.status().lastReason, REASONS.SPAWN_FAILED)
  assert.equal(supervisor.status().lastExitAt, null)
  clock.advance(RESTART_FLOOR_MS)
  assert.equal(spawn.calls.length, 2)
  assert.equal(supervisor.status().running, true)
})

/* ------------------------------------------------------------- §4.1, §6.3 */

function prefsHolding(values) {
  return { snapshot: () => ({ ok: true, values, drainedOrigins: [], damaged: null, preservedAt: null }) }
}

test('the web-drive switch is off until somebody turns it on', () => {
  assert.equal(webDriveMayWrite(prefsHolding({})), false)
  assert.equal(webDriveMayWrite(prefsHolding({ 'mc.theme': 'black' })), false)
})

test('the web-drive switch is on only for the exact recorded value', () => {
  assert.equal(webDriveMayWrite(prefsHolding({ [WEB_DRIVE_PREF_KEY]: 'on' })), true)
})

test('anything that is not the recorded value is off', () => {
  for (const value of ['ON', 'On', 'true', 'yes', '1', 'off', '', ' on', 'on ', 'enabled']) {
    assert.equal(
      webDriveMayWrite(prefsHolding({ [WEB_DRIVE_PREF_KEY]: value })),
      false,
      `${JSON.stringify(value)} must not grant write access`,
    )
  }
})

test('a malformed record cannot grant write access', () => {
  const shapes = [
    { snapshot: () => null },
    { snapshot: () => 'nonsense' },
    { snapshot: () => ({ ok: true }) },
    { snapshot: () => ({ ok: true, values: null }) },
    { snapshot: () => ({ ok: true, values: ['mc.relay.web-drive', 'on'] }) },
    { snapshot: () => ({ ok: true, values: { [WEB_DRIVE_PREF_KEY]: { on: true } } }) },
    {},
    null,
    undefined,
  ]
  for (const prefs of shapes) assert.equal(webDriveMayWrite(prefs), false)
})

/* THE ONE THAT MATTERS MOST. A store that cannot be read is a machine that
   does not know what its owner chose, and "I could not check" must never
   render as "you may drive this computer from the web". */
test('a store that cannot be read grants nothing', () => {
  const throwing = { snapshot: () => { throw new Error('EBUSY') } }
  assert.equal(webDriveMayWrite(throwing), false)
})

/* THE WRITER AND THE READER SPELL THE KEY THE SAME WAY. The switch in the
   connect section (src/connect-computer-settings.js) writes through
   src/device-claim-flow.js's constants, because an ES module cannot import
   this CommonJS one; a drift between the two spellings would be a switch that
   saves and a reader that never sees it -- fail-closed, silent, and permanent. */
test('the renderer spells the key and the value exactly as this reader does', () => {
  assert.equal(RENDERER_WEB_DRIVE_PREF_KEY, WEB_DRIVE_PREF_KEY)
  assert.equal(RENDERER_WEB_DRIVE_ON, WEB_DRIVE_ON)
})

/* THE REAL STORE, END TO END: what the connect section's writer does to a
   real renderer-prefs file is what this reader answers on the next command.
   set 'on' → true; remove → false; any other spelling → false. */
test('a real renderer-prefs store written the way the switch writes it is read the way the relay reads it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-web-drive-'))
  try {
    const prefs = rendererPrefs.createRendererPrefs({ directory, fs, path, randomUUID })
    assert.equal(webDriveMayWrite(prefs), false, 'unset is off')
    assert.equal(prefs.set(RENDERER_WEB_DRIVE_PREF_KEY, RENDERER_WEB_DRIVE_ON).ok, true)
    assert.equal(webDriveMayWrite(prefs), true, 'the switch turned on is read as on, with no restart')
    assert.equal(prefs.remove(RENDERER_WEB_DRIVE_PREF_KEY).ok, true)
    assert.equal(webDriveMayWrite(prefs), false, 'the switch turned off removes the key, and that reads as off')
    assert.equal(prefs.set(RENDERER_WEB_DRIVE_PREF_KEY, 'true').ok, true)
    assert.equal(webDriveMayWrite(prefs), false, 'a different spelling of on is off')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a damaged settings record grants nothing, even if a value survived in it', () => {
  const damaged = {
    snapshot: () => ({
      ok: true,
      values: { [WEB_DRIVE_PREF_KEY]: 'on' },
      drainedOrigins: [],
      damaged: 'the settings file contains malformed JSON',
      preservedAt: null,
    }),
  }
  assert.equal(webDriveMayWrite(damaged), false)
})

/* WHEN A LEG DIES, SOMETHING MUST SAY WHY.
 *
 * The child's pipes were drained and dropped -- read only so a long-running
 * child could not block on a full pipe, with nothing kept. The draining was
 * right; discarding the lines was not. Those lines are the ONLY record anywhere
 * of why a relay leg failed.
 *
 * Measured 2026-08-22: an agent standing up a real machine could not find out
 * why its leg would not connect, and got there by killing the app and running
 * tools/relay-shell.js by hand to watch it speak. Nobody has that path on a
 * customer's computer.
 *
 * They go to the LOG and never to status(). This file's own header refused to
 * let anything the child printed reach a surface a page could render, so that a
 * child which forgets its manners cannot leak a pair id or a machine name
 * through here. That defence is kept; the test below pins both halves. */
test('a leg that dies badly leaves its last words in the log, and never in status()', () => {
  const { supervisor, spawn, logged } = supervisorUnderTest()
  supervisor.start()
  const child = spawn.calls[0].child

  child.stderr.emit('data', '[relay-shell] event online_fra_shell_admitted role=machine-a' + String.fromCharCode(10))
  child.stderr.emit('data', '[relay-shell] not connected: RELAY_SHELL_LEASE_REFUSED' + String.fromCharCode(10))
  child.emit('exit', 1, null)

  const said = logged.join(String.fromCharCode(10))
  assert.match(said, /last words/,
    'a leg died and the supervisor said nothing about what it had been saying on the way out')
  assert.match(said, /RELAY_SHELL_LEASE_REFUSED/,
    'the reason the leg gave is exactly what somebody diagnosing this needs, and it was being thrown away')

  /* AND NOT INTO status(). The header of relay-supervisor.cjs refuses to let
     anything the child printed reach a surface a page can render, so that a
     child which forgets its manners cannot leak a pair id or a machine name
     through this module. That defence is deliberately kept. */
  const status = supervisor.status()
  assert.equal(JSON.stringify(status).includes('RELAY_SHELL_LEASE_REFUSED'), false,
    'something the child printed reached status()')
  assert.deepEqual(Object.keys(status).sort(), ['lastExitAt', 'lastReason', 'restarts', 'running'],
    'status() grew a field; it carries a word from a closed set and three plain numbers, on purpose')
})

test('a leg that stops cleanly says nothing extra', () => {
  const { supervisor, spawn, logged } = supervisorUnderTest()
  supervisor.start()
  const child = spawn.calls[0].child
  child.stderr.emit('data', '[relay-shell] session closed' + String.fromCharCode(10))
  child.emit('exit', 0, null)
  assert.equal(logged.join(String.fromCharCode(10)).includes('last words'), false,
    'a leg that stopped because it was asked to has nothing to explain, and printing forty lines every time buries the one time it matters')
})

test('claim and relay children retain only the current platform’s desktop session fields without credentials', () => {
  const source = {
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    NODE_OPTIONS: '--require=untrusted.js',
    GOOGLE_CLIENT_SECRET: 'fixture-secret',
    TOOLSENABLED_VAULT_PATH: '/untrusted/vault',
  }
  const actual = relaySupervisor.relayChildEnvironment(source, { stateRoot: STATE_ROOT })
  assert.deepEqual(actual, {
    ...(process.platform === 'linux' ? {
      DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
    } : {}),
    ELECTRON_RUN_AS_NODE: '1',
    TOOLSENABLED_STATE_ROOT: STATE_ROOT,
  })
})
