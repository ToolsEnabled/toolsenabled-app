import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { runDockerSetupAction } from '../../src/setup-docker.js'
const require = createRequire(import.meta.url)
const { createSandboxSetup, createSandboxSetupExecutor } = require('../../shell/sandbox-setup.cjs')
test('runtime payload declares the complete fixed sandbox build context, not just its provider', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../capability-manifest.json', import.meta.url), 'utf8'))
  const boundary = JSON.parse(fs.readFileSync(new URL('../../config/payload-boundary.json', import.meta.url), 'utf8'))
  const files = ['Dockerfile', 'package.json', 'package-lock.json', 'bounded-exec.js', 'fixture-server.js', 'hold-open.js']
  for (const file of files) {
    const relative = `docker/agent-sandbox/${file}`
    assert.equal(manifest.dataFiles.filter(value => value === relative).length, 1, `${relative} must ship once`)
    assert.ok(boundary.open.paths.includes(relative), `${relative} requires explicit payload classification`)
  }
  assert.ok(!manifest.dataFiles.includes('docker/agent-sandbox'), 'no broad directory inclusion')
})
test('owner sender and empty payload are mandatory before native confirmation or work', async () => {
  let confirmed = 0, executed = 0
  const setup = createSandboxSetup({ preparationSupported: true, authorize: e => e === 'owner', confirm: async () => { confirmed++; return true }, execute: async () => { executed++ } })
  assert.equal((await setup.run('other', 'prepare')).code, 'SANDBOX_SETUP_SENDER_REFUSED')
  for (const input of [null, {}, { allowBuild: true }, '/outside', ['--inspect']]) {
    assert.equal((await setup.run('owner', 'prepare', input)).code, 'SANDBOX_SETUP_INPUT_INVALID')
  }
  assert.equal(confirmed, 0); assert.equal(executed, 0)
})
test('decline changes nothing and owner navigation during confirmation refuses', async () => {
  let trusted = true, executed = 0
  const setup = createSandboxSetup({ preparationSupported: true, authorize: () => trusted,
    confirm: async () => { trusted = false; return true }, execute: async () => { executed++ } })
  assert.equal((await setup.run(null, 'prepare')).code, 'SANDBOX_SETUP_SENDER_REFUSED')
  const declined = createSandboxSetup({ preparationSupported: true, authorize: () => true, confirm: async () => false, execute: async () => { executed++ } })
  assert.equal((await declined.run(null, 'prepare')).code, 'SANDBOX_SETUP_DECLINED')
  assert.equal(executed, 0)
})
test('confirmation and execution share one app-wide flight; read does not confirm', async () => {
  let release, confirmations = 0, executions = 0
  const setup = createSandboxSetup({ preparationSupported: true, authorize: () => true,
    confirm: () => { confirmations++; return new Promise(r => { release = r }) },
    execute: async () => { executions++; return { ok: true, ready: false } } })
  const pending = setup.run(null, 'prepare')
  assert.equal((await setup.run(null, 'doctor')).code, 'SANDBOX_SETUP_BUSY')
  release(true); await pending
  await setup.run(null, 'doctor')
  assert.equal(confirmations, 1); assert.equal(executions, 2)
})
function executorFixture() {
  const children = [], calls = [], timers = []
  const execute = createSandboxSetupExecutor({ capabilityRoot: '/sealed/capability', stateRoot: '/profile/capability', executable: '/sealed/toolsenabled',
    environment: { NODE_OPTIONS: '--require /bad', NODE_PATH: '/bad', LD_PRELOAD: '/bad', PATH: '/usr/bin' },
    spawnChild(...args) { calls.push(args); const child = new EventEmitter(); children.push(child); return child },
    setTimer(fn) { timers.push(fn); return fn }, clearTimer() {},
  })
  return { execute, children, calls, timers }
}
test('fixed worker launch has no renderer arguments or Node/loader injection; readiness requires clean exit', async () => {
  const f = executorFixture(), pending = f.execute('doctor'), child = f.children[0]
  const [exe, args, options] = f.calls[0]
  assert.equal(exe, '/sealed/toolsenabled')
  assert.equal(args[0], fileURLToPath(new URL('../../shell/sandbox-setup-worker.cjs', import.meta.url)))
  assert.deepEqual(args.slice(1), ['/sealed/capability', 'doctor'])
  assert.equal(options.env.TOOLSENABLED_STATE_ROOT, '/profile/capability')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']) assert.equal(options.env[key], undefined)
  assert.equal(options.shell, false)
  child.emit('message', { protocol: 'toolsenabled.sandbox-setup/1', ok: true, status: 'ready' })
  child.emit('exit', 1)
  assert.equal((await pending).ok, false)
})
test('watchdog never claims cancellation and keeps flight blocked until actual child exit', async () => {
  const f = executorFixture(), pending = f.execute('prepare')
  f.timers[0]()
  const result = await pending
  assert.equal(result.code, 'SANDBOX_SETUP_TIMEOUT'); assert.match(result.message, /no cancellation/)
  assert.equal((await f.execute('prepare')).code, 'SANDBOX_SETUP_BUSY')
  f.children[0].emit('exit', 0)
  const next = f.execute('doctor')
  f.children[1].emit('message', { protocol: 'toolsenabled.sandbox-setup/1', ok: true, status: 'not-ready', code: 'SANDBOX_IMAGE_NOT_PROVISIONED' })
  f.children[1].emit('exit', 0)
  assert.equal((await next).ready, false)
})
test('composed fleet-profile preload invokes the guarded fixed channels without arguments', async () => {
  const source = fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
  const start = source.indexOf("contextBridge.exposeInMainWorld('mcSetup'")
  const end = source.indexOf('\n}))', start) + 4
  assert.ok(start >= 0 && end > start)
  const calls = []; let exposed
  vm.runInNewContext(source.slice(start, end), { process: { platform: 'linux' }, setup: {}, contextBridge: { exposeInMainWorld(_name, value) { exposed = value } },
    ipcRenderer: { invoke: (...args) => calls.push(args) } })
  await exposed.sandboxStatus(); await exposed.prepareSandbox()
  assert.deepEqual(calls, [['mc-setup:sandbox-status'], ['mc-setup:sandbox-prepare']])
})
test('UI only declares ready on explicit verified readiness, never Docker installed alone', async () => {
  const status = { textContent: '' }, buttons = [{ disabled: false }, { disabled: false }]
  const section = { querySelector: () => status, querySelectorAll: () => buttons }
  for (const answer of [{ ok: true, available: true }, { ok: true, status: 'ready', ready: false }, { ok: false, ready: true }]) {
    await runDockerSetupAction(section, 'check', { sandboxStatus: async () => answer })
    assert.match(status.textContent, /not been established/)
    assert.ok(buttons.every(b => !b.disabled))
  }
  await runDockerSetupAction(section, 'check', { sandboxStatus: async () => ({ ok: true, status: 'ready', ready: true }) })
  assert.match(status.textContent, /readiness verified/)
})
test('fixed worker runs real production dispatcher with provider fixtures, emits bounded readiness only', () => {
  const source = fs.readFileSync(new URL('../../shell/sandbox-setup-worker.cjs', import.meta.url), 'utf8')
  for (const ready of [true, false]) {
    let packet
    vm.runInNewContext(source, { require: name => name === 'node:path' ? require('node:path')
      : { doctor: () => ({ available: true, compatible: true, imageReady: ready, secret: 'must-not-leak' }) },
      process: { argv: ['node', 'fixed-worker', '/sealed/capability', 'doctor'], env: { TOOLSENABLED_STATE_ROOT: '/profile/capability' },
        send(value, callback) { packet = value; callback() }, disconnect() {} } })
    assert.equal(packet.status, ready ? 'ready' : 'not-ready')
    assert.equal(packet.secret, undefined)
  }
})
test('actual main setup wiring enforces platform support and owner confirmation', async () => {
  const source = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = source.indexOf("const { createSandboxSetup, createSandboxSetupExecutor } = require('./sandbox-setup.cjs')")
  const marker = "ipcMain.handle('mc-setup:sandbox-prepare', (event, value) => sandboxSetup.run(event, 'prepare', value))"
  const end = source.indexOf(marker, start) + marker.length
  assert.ok(start >= 0 && end > start)
  const handlers = new Map(), dialogs = [], runs = []
  let response = 0
  vm.runInNewContext(source.slice(start, end), { require: () => ({ createSandboxSetup,
    createSandboxSetupExecutor: () => async mode => { runs.push(mode); return { ok: true } } }),
    appShutdown: { started: false }, trustedFleetProfileSender: event => event === 'owner', resolveCapabilityRoot: () => '/sealed/capability', CAPABILITY_STATE_ROOT: '/profile/capability',
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, win: {},
    dialog: { showMessageBox: async (_win, options) => { dialogs.push(options); return { response } } },
  })
  const prepare = handlers.get('mc-setup:sandbox-prepare')
  await prepare('other'); assert.equal(dialogs.length, 0)
  const first = await prepare('owner'); assert.equal(runs.length, 0)
  if (process.platform !== 'linux') {
    assert.equal(first.code, 'SANDBOX_SETUP_COORDINATION_UNSUPPORTED')
    assert.equal(dialogs.length, 0)
    return
  }
  assert.equal(dialogs[0].cancelId, 0); assert.equal(dialogs[0].defaultId, 0)
  assert.match(dialogs[0].detail, /downloads.*pinned/)
  response = 1; await prepare('owner'); assert.deepEqual(runs, ['prepare'])
})
test('environment construction failure releases flight and allows a later real spawn', async () => {
  let broken = true, child
  const environment = { get BAD() { if (broken) throw new Error('environment unavailable'); return '' } }
  const execute = createSandboxSetupExecutor({ capabilityRoot: '/sealed', stateRoot: '/profile', environment,
    spawnChild() { child = new EventEmitter(); return child }, setTimer: () => 1, clearTimer() {} })
  assert.equal((await execute('doctor')).code, 'SANDBOX_SETUP_START_FAILED')
  broken = false
  const pending = execute('doctor')
  assert.ok(child)
  child.emit('exit', 1)
  assert.equal((await pending).code, 'SANDBOX_SETUP_FAILED')
})
test('error after successful spawn cannot release live PID flight; late old events cannot release new flight', async () => {
  const f = executorFixture(), pending = f.execute('prepare'), old = f.children[0]
  old.pid = 1234
  old.emit('error', new Error('IPC send failed'))
  await pending
  assert.equal((await f.execute('doctor')).code, 'SANDBOX_SETUP_BUSY')
  old.emit('exit', 1)
  const next = f.execute('doctor')
  old.emit('exit', 1)
  assert.equal((await f.execute('doctor')).code, 'SANDBOX_SETUP_BUSY')
  f.children[1].emit('exit', 1); await next
})
test('confirmed spawn error without PID releases flight even without exit', async () => {
  const f = executorFixture(), first = f.execute('doctor')
  f.children[0].emit('error', new Error('ENOENT')); await first
  const second = f.execute('doctor')
  assert.equal(f.children.length, 2)
  f.children[1].emit('exit', 1); await second
})
test('specific fixed remedies distinguish image provisioning from Docker prerequisites without PowerShell', async () => {
  const status = { textContent: '' }, buttons = [{ disabled: false }]
  const section = { querySelector: () => status, querySelectorAll: () => buttons }
  for (const [code, phrase] of [
    ['SANDBOX_IMAGE_NOT_PROVISIONED', /Prepare sandbox image/],
    ['SANDBOX_DOCKER_UNAVAILABLE', /not running/],
    ['SANDBOX_LINUX_WORKSPACE_REFUSED', /rootless Docker/],
    ['SANDBOX_DOCKER_INCOMPATIBLE', /Docker 28/],
    ['SANDBOX_IMAGE_UNTRUSTED', /not be silently replaced/],
  ]) {
    await runDockerSetupAction(section, 'check', { sandboxStatus: async () => ({ ok: true, ready: false, code }) })
    assert.match(status.textContent, phrase); assert.doesNotMatch(status.textContent, /powershell|\.ps1/i)
  }
})
test('shutdown seals admission including an already-open native confirmation', async () => {
  let confirm, executions = 0
  const setup = createSandboxSetup({ preparationSupported: true, authorize: () => true,
    confirm: () => new Promise(resolve => { confirm = resolve }), execute: async () => { executions++ } })
  const pending = setup.run(null, 'prepare')
  setup.sealAdmission(); confirm(true)
  assert.equal((await pending).code, 'SANDBOX_SETUP_SHUTTING_DOWN')
  assert.equal((await setup.run(null, 'doctor')).code, 'SANDBOX_SETUP_SHUTTING_DOWN')
  assert.equal(executions, 0)
})
test('shutdown observes exact child exit without killing or claiming canceled daemon work', async () => {
  const f = executorFixture(), operation = f.execute('prepare')
  const observation = f.execute.waitForExit()
  assert.equal((await f.execute('prepare')).code, 'SANDBOX_SETUP_SHUTTING_DOWN')
  f.children[0].emit('exit', 1)
  assert.equal((await observation).status, 'exited'); await operation
  const g = executorFixture(), pending = g.execute('prepare'), unknown = g.execute.waitForExit()
  g.timers[1]()
  assert.equal((await unknown).status, 'unknown')
  g.children[0].emit('exit', 1); await pending
})
test('actual worker releases known prebuild failure but retains uncertain build journal', () => {
  const source = fs.readFileSync(new URL('../../shell/sandbox-setup-worker.cjs', import.meta.url), 'utf8')
  for (const startBuild of [false, true]) {
    let marked = false, packet, finished
    vm.runInNewContext(source, { require: name => {
      if (name === 'node:path') return require('node:path')
      if (name === './sandbox-setup-lease.cjs') return { acquireSandboxPreparation: () => ({
        markBuildStarted() { marked = true }, finish(value) { finished = value; return { recoveryRequired: marked } },
      }) }
      return { createSandboxImageProvisioner: ({ onImageBuildStart }) => ({ prepareSandboxImage() {
        if (startBuild) onImageBuildStart(); throw Object.assign(new Error('Failure'), { code: 'SANDBOX_DOCKER_FAILED' })
      } }) }
    }, process: { argv: ['node', 'worker', '/sealed/capability', 'prepare'], env: { TOOLSENABLED_STATE_ROOT: '/profile' },
      send(value, callback) { packet = value; callback() }, disconnect() {} } })
    assert.equal(finished.completed, false)
    assert.equal(packet.code, startBuild ? 'SANDBOX_SETUP_RECOVERY_REQUIRED' : 'SANDBOX_DOCKER_FAILED')
  }
})
test('Windows preparation refuses before confirmation; doctor stays usable', async () => {
  let confirmations = 0, executed = 0
  const setup = createSandboxSetup({ authorize: () => true, preparationSupported: false,
    confirm: async () => { confirmations++; return true }, execute: async () => { executed++; return { ok: true } } })
  assert.equal((await setup.run(null, 'prepare')).code, 'SANDBOX_SETUP_COORDINATION_UNSUPPORTED')
  await setup.run(null, 'doctor')
  assert.equal(confirmations, 0); assert.equal(executed, 1)
})
test('malformed journal copy requests review instead of promising reboot recovery', async () => {
  const status = { textContent: '' }, section = { querySelector: () => status, querySelectorAll: () => [] }
  await runDockerSetupAction(section, 'check', { sandboxStatus: async () => ({ ok: false, code: 'SANDBOX_SETUP_JOURNAL_UNREADABLE' }) })
  assert.match(status.textContent, /support review/); assert.match(status.textContent, /not a guaranteed repair/)
})
