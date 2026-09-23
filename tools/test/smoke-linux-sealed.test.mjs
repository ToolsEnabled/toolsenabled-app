import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseOptions, launchArguments, launchEnvironment, validateDebugPort, validateLoopback,
  assertAttestation, assertBuildMetadata, assertFusePolicy, processIdentity, boundedGateChild,
  ownerSocketClosed, rendererApiProbe, gateEnvironment, bindAppSource, installedPhase, assertInstalledRuntime,
  assertShortTempBudget, createShortLaunchTemp, releaseShortLaunchTemp, rendererSetupReadiness, waitForReadableSetup } from '../smoke-linux-sealed.mjs'

const REF = 'a'.repeat(40), ENGINE = 'b'.repeat(40)
const { shortLinuxTmpdir } = createRequire(import.meta.url)('../lib/sterile-launch.cjs')
test('setup readiness waits for ancestor opacity, active entrance transitions, readable labels and fonts', () => {
  const make = (parentElement = null) => ({ parentElement, style: { opacity: '1', visibility: 'visible', display: 'block' },
    getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 100, height: 30, top: 10, left: 10, bottom: 40, right: 110 }),
    getAnimations: () => [], textContent: 'Continue', dataset: { setupTier: 'confined' } })
  const ancestor = make(), section = make(ancestor), choice = make(section), button = make(section)
  const document = { title: 'Setup', visibilityState: 'visible', fonts: { status: 'loaded' }, querySelector: () => section,
    querySelectorAll: selector => selector === '[data-setup-tier]' ? [choice] : [button] }
  const context = { document, innerHeight: 1000, innerWidth: 1000, getComputedStyle: element => element.style }
  const probe = () => vm.runInNewContext(`(${rendererSetupReadiness.toString()})()`, context)
  assert.equal(probe().readable, true)
  ancestor.style.opacity = '0'; assert.equal(probe().readable, false)
  ancestor.style.opacity = '0.5'; assert.equal(probe().readable, false)
  ancestor.style.opacity = '1'
  ancestor.getAnimations = () => [{ playState: 'running', effect: { getKeyframes: () => [{ opacity: '0' }, { opacity: '1' }] } }]
  assert.equal(probe().readable, false)
  ancestor.getAnimations = () => []; document.fonts.status = 'loading'; assert.equal(probe().readable, false)
  document.fonts.status = 'loaded'; button.textContent = ''; assert.equal(probe().readable, false)
  button.textContent = 'Continue'; choice.style.visibility = 'hidden'; assert.equal(probe().readable, false)
})
test('readable setup polling is condition-bound and fails honestly if animation never settles', async () => {
  let calls = 0
  const ready = await waitForReadableSetup({ evaluate: async () => ({ readable: ++calls >= 3 }) }, { timeoutMs: 100, pollMs: 1 })
  assert.equal(ready.readable, true); assert.equal(calls, 3)
  await assert.rejects(waitForReadableSetup({ evaluate: async () => ({ readable: false }) }, { timeoutMs: 5, pollMs: 1 }), /SETUP_NOT_READABLE/)
})
const args = ['--artifact', '/artifact', '--expected-app-ref', REF, '--expected-engine-ref', ENGINE, '--app-source', '/app', '--engine-source', '/engine']
const installedArgs = ['--artifact', '/opt/ToolsEnabled', ...args.slice(2), '--proof-mode', 'installed',
  '--deb', '/evidence/app.deb', '--expected-package-sha256', 'c'.repeat(64),
  '--installed-manifest', '/evidence/manifest.json', '--expected-manifest-sha256', 'd'.repeat(64)]
test('installed proof requires fixed root and both externally selected digest bindings without weakening unpacked mode', { skip: process.platform !== 'linux' ? 'Linux sealed proof uses Linux paths and launch environment' : false }, () => {
  const options = parseOptions(installedArgs)
  assert.equal(options.proofMode, 'installed')
  assert.equal(options.artifact, '/opt/ToolsEnabled')
  assert.equal(parseOptions(args).proofMode, 'unpacked')
  assert.throws(() => parseOptions([...args, '--deb', '/evidence/app.deb']))
  assert.throws(() => parseOptions(installedArgs.slice(0, -2)))
  assert.throws(() => parseOptions(installedArgs.map(value => value === '/opt/ToolsEnabled' ? '/tmp/ToolsEnabled' : value)))
  assert.throws(() => parseOptions(installedArgs.map(value => value === '/evidence/manifest.json' ? '/opt/ToolsEnabled/manifest.json' : value)))
  assert.throws(() => parseOptions(installedArgs.map(value => value === 'c'.repeat(64) ? 'main' : value)))
})
test('installed pre and post independently verify package binding and read-only tree; no missing phase is fabricated', { skip: process.platform !== 'linux' ? 'Linux sealed proof uses Linux paths and launch environment' : false }, async () => {
  const options = parseOptions(installedArgs), seen = [], manifest = { fixture: true }
  const operations = {
    verifyExternalManifest: async value => { assert.equal(value, options); seen.push('binding'); return manifest },
    verifyInstalledTree: async value => { assert.equal(value, manifest); seen.push('tree'); return { installedTreeMatches: true, readonlyObserved: true, profileMatches: true } },
  }
  const before = await installedPhase(options, 'before', operations)
  const after = await installedPhase(options, 'after', operations)
  assert.deepEqual(seen, ['binding', 'tree', 'binding', 'tree'])
  assert.equal(before.receipt.phase, 'before'); assert.equal(after.receipt.phase, 'after')
  await assert.rejects(installedPhase(options, 'after', { ...operations, verifyExternalManifest: async () => { throw new Error('changed package') } }), /changed package/)
  await assert.rejects(installedPhase(options, 'after', { ...operations, verifyInstalledTree: async () => ({ installedTreeMatches: true }) }), /PROOF_INCOMPLETE/)
  await assert.rejects(installedPhase({ ...options, artifact: '/tmp/fake-install' }, 'before', operations), /PHASE_INVALID/)
})
test('actual installed runtime must match fixed packaged paths, source/package bytes and exact AppArmor attachment', () => {
  const manifest = { package: { version: '1.0.42' }, source: { appRef: REF, engineRef: ENGINE }, entries: [{ path: 'toolsenabled', sha256: 'c'.repeat(64) }] }
  const build = { appRef: REF, engineRef: ENGINE, executableSha256: 'c'.repeat(64) }
  const runtime = { isPackaged: true, execPath: '/opt/ToolsEnabled/toolsenabled', resourcesPath: '/opt/ToolsEnabled/resources', appPath: '/opt/ToolsEnabled/resources/app.asar', version: '1.0.42' }
  assert.equal(assertInstalledRuntime(runtime, manifest, build, 'toolsenabled-customer (unconfined)\n', true).fixedInstalledRuntime, true)
  assert.equal(assertInstalledRuntime(runtime, manifest, build, 'unconfined\n', false).appArmorAttachment, 'not-required')
  for (const label of ['unconfined', 'toolsenabled-linux-live (unconfined)', 'toolsenabled-customer (complain)']) assert.throws(() => assertInstalledRuntime(runtime, manifest, build, label, true))
  assert.throws(() => assertInstalledRuntime({ ...runtime, execPath: '/home/fake/toolsenabled' }, manifest, build, 'toolsenabled-customer (unconfined)', true))
  assert.throws(() => assertInstalledRuntime(runtime, manifest, { ...build, executableSha256: 'd'.repeat(64) }, 'toolsenabled-customer (unconfined)', true))
  assert.throws(() => assertInstalledRuntime({ ...runtime, version: '1.0.41' }, manifest, build, 'toolsenabled-customer (unconfined)', true))
})
test('sealed harness demands exact references and refuses escape hatches/duplicates', { skip: process.platform !== 'linux' ? 'Linux sealed proof uses Linux paths and launch environment' : false }, () => {
  assert.equal(parseOptions(args).artifact, '/artifact')
  for (const extra of [['--no-sandbox', '1'], ['--skip-gates', '1'], ['--entrypoint', 'shell/main.cjs'], ['--artifact', '/other']]) {
    assert.throws(() => parseOptions([...args, ...extra]))
  }
  assert.throws(() => parseOptions(['--artifact', '/artifact']))
  assert.throws(() => parseOptions(args.slice(0, -2)), /SEALED_ENGINE_SOURCE_REQUIRED/)
  assert.throws(() => parseOptions(args.filter((_, i) => i !== 6 && i !== 7)), /SEALED_APP_SOURCE_REQUIRED/)
  assert.throws(() => parseOptions([...args, '--evidence-dir', '/artifact/reports']))
  assert.throws(() => parseOptions([...args, '--timeout-ms', 'Infinity']))
  assert.throws(() => parseOptions([...args, '--expected-app-ref']))
})
test('only currentness gate receives an explicit clean exact engine source; GUI stays sterile', { skip: process.platform !== 'linux' ? 'Linux sealed proof uses Linux paths and launch environment' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-source-binding-'))
  try {
    const git = (...argv) => execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', windowsHide: true })
    git('init', '--quiet')
    fs.mkdirSync(path.join(dir, 'tools'))
    fs.mkdirSync(path.join(dir, 'shell'))
    fs.writeFileSync(path.join(dir, 'shell/main.cjs'), '// fixture\n')
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n')
    fs.writeFileSync(path.join(dir, 'tools/mission-bridge.js'), '// fixture\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture')
    const engineRef = git('rev-parse', 'HEAD').trim()
    const profile = { userProfile: '/fresh/home', appData: '/fresh/config', localAppData: '/fresh/local', codexHome: '/fresh/codex', temp: '/fresh/temp' }
    const env = Object.freeze(launchEnvironment(profile, { TOOLSENABLED_SOURCE: '/owner/engine', TOOLSENABLED_SOURCE_REF: REF }))
    const options = { appSource: dir, appRef: engineRef, engineSource: dir, engineRef }
    assert.equal(bindAppSource(options, env), fs.realpathSync(dir))
    assert.throws(() => bindAppSource({ ...options, appSource: undefined }, env), /SEALED_APP_SOURCE_REQUIRED/)
    assert.throws(() => bindAppSource({ ...options, appSource: path.join(dir, 'missing') }, env))
    assert.throws(() => bindAppSource({ ...options, appRef: REF }, env), /differs from declared ref/)
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'dist/index.html'), 'ignored output remains subject to real renderer gate')
    assert.equal(bindAppSource(options, env), fs.realpathSync(dir))
    const scoped = gateEnvironment('check-payload-current.mjs', env, options)
    assert.equal(scoped.TOOLSENABLED_SOURCE, fs.realpathSync(dir))
    assert.equal(scoped.TOOLSENABLED_SOURCE_REF, engineRef)
    assert.equal(env.TOOLSENABLED_SOURCE, undefined)
    assert.equal(env.TOOLSENABLED_SOURCE_REF, undefined)
    assert.equal(gateEnvironment('check-no-owner-data.mjs', env, options), env)
    assert.throws(() => gateEnvironment('check-payload-current.mjs', env, { engineRef }), /SEALED_ENGINE_SOURCE_REQUIRED/)
    assert.throws(() => gateEnvironment('check-payload-current.mjs', env, { ...options, engineSource: path.join(dir, 'missing') }))
    assert.throws(() => gateEnvironment('check-payload-current.mjs', env, { ...options, engineRef: REF }), /differs from declared ref/)
    fs.appendFileSync(path.join(dir, 'tools/mission-bridge.js'), '// dirty\n')
    assert.throws(() => gateEnvironment('check-payload-current.mjs', env, options), /dirty or has untracked/)
    assert.throws(() => bindAppSource(options, env), /dirty or has untracked/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('sealed native arguments never inject source or sandbox/inspector bypass', () => {
  assert.deepEqual(launchArguments('/fresh/profile'), ['--user-data-dir=/fresh/profile', '--remote-debugging-port=0'])
  assert.throws(() => launchArguments('relative'))
})
test('Linux launch temp is short, private and unique; no owner temp/profile is shared', { skip: process.platform !== 'linux' }, () => {
  const first = createShortLaunchTemp(), second = createShortLaunchTemp()
  try {
    assert.notEqual(first.directory, second.directory)
    for (const receipt of [first, second]) {
      assertShortTempBudget(receipt.directory)
      assert.equal(fs.statSync(receipt.directory).mode & 0o777, 0o700)
      const env = launchEnvironment({ userProfile: '/fresh/home', appData: '/fresh/config', localAppData: '/fresh/local', codexHome: '/fresh/codex', temp: receipt.directory }, { TMPDIR: '/owner/long/temp', TEMP: '/owner/temp', HOME: '/owner' })
      assert.equal(env.TMPDIR, shortLinuxTmpdir(), 'Chromium uses the verified short socket directory')
      assertShortTempBudget(env.TMPDIR)
      assert.equal(env.TEMP, receipt.directory)
      assert.equal(env.HOME, '/fresh/home')
    }
    assert.throws(() => assertShortTempBudget('/tmp/' + 'a'.repeat(30)), /SOCKET_PATH_TOO_LONG/)
    assert.throws(() => assertShortTempBudget('/tmp/' + 'é'.repeat(15)), /SOCKET_PATH_TOO_LONG/)
    assert.equal(releaseShortLaunchTemp(first, { childTerminal: false }).removed, false)
    assert.equal(releaseShortLaunchTemp(first, { childTerminal: true, remainingPids: [1] }).removed, false)
    assert.equal(releaseShortLaunchTemp(first, { childTerminal: true, gateCleanupUnprovenPids: [2] }).removed, false)
    assert.equal(releaseShortLaunchTemp(first, { childTerminal: true }).removed, true)
    fs.writeFileSync(path.join(second.directory, 'diagnostic'), 'retain this')
    assert.equal(releaseShortLaunchTemp(second, { childTerminal: true }).reason, 'nonempty-evidence-retained')
    assert.equal(fs.readFileSync(path.join(second.directory, 'diagnostic'), 'utf8'), 'retain this')
    assert.throws(() => releaseShortLaunchTemp({ ...second, ino: second.ino + 1 }, { childTerminal: true }), /IDENTITY_CHANGED/)
  } finally {
    for (const receipt of [first, second]) fs.rmSync(receipt.directory, { recursive: true, force: true })
  }
})
test('sterile sealed environment discards provider credentials, Docker overrides and injected startup hooks', () => {
  const profile = { userProfile: '/fresh/home', appData: '/fresh/config', localAppData: '/fresh/local', codexHome: '/fresh/codex', temp: '/fresh/temp' }
  const env = launchEnvironment(profile, { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    HOME: '/owner', CODEX_HOME: '/owner/.codex', CLAUDE_CONFIG_DIR: '/owner/.claude', ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require bad', LD_PRELOAD: 'bad',
    MC_SMOKE_HEADLESS: '1', DOCKER_HOST: 'tcp://foreign:2375', DOCKER_CONTEXT: 'foreign', PATH: '/owner/bin' })
  assert.equal(env.HOME, '/fresh/home')
  assert.equal(env.CODEX_HOME, '/fresh/codex')
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.DISPLAY, ':0')
  for (const key of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
    'LD_PRELOAD', 'MC_SMOKE_HEADLESS', 'DOCKER_HOST', 'DOCKER_CONTEXT']) assert.equal(env[key], undefined, key)
})
test('sterile harness preserves only explicit desktop-session selectors without inventing absent session metadata', () => {
  const profile = { userProfile: '/fresh/home', appData: '/fresh/config', localAppData: '/fresh/local', codexHome: '/fresh/codex', temp: '/fresh/temp' }
  const session = { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_DESKTOP: 'ubuntu', DESKTOP_SESSION: 'ubuntu',
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
  const env = launchEnvironment(profile, { ...session, XDG_CONFIG_HOME: '/owner/config', XDG_DATA_HOME: '/owner/data',
    XDG_UNKNOWN_SELECTOR: 'not-allowed', GNOME_KEYRING_CONTROL: '/owner/keyring', ELECTRON_PASSWORD_STORE: 'basic',
    OPENAI_API_KEY: 'must-not-pass', ANTHROPIC_API_KEY: 'must-not-pass', NODE_OPTIONS: '--require unwanted', HOME: '/owner' })
  for (const [key, value] of Object.entries(session)) assert.equal(env[key], value)
  for (const key of ['XDG_UNKNOWN_SELECTOR', 'GNOME_KEYRING_CONTROL', 'ELECTRON_PASSWORD_STORE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(env[key], undefined)
  assert.notEqual(env.XDG_CONFIG_HOME, '/owner/config')
  assert.notEqual(env.XDG_DATA_HOME, '/owner/data')
  assert.equal(env.HOME, '/fresh/home')
  const absent = launchEnvironment(profile, {})
  for (const key of Object.keys(session)) assert.equal(absent[key], undefined)
  const invalid = launchEnvironment(profile, { XDG_CURRENT_DESKTOP: false, DESKTOP_SESSION: 123 })
  assert.equal(invalid.XDG_CURRENT_DESKTOP, undefined)
  assert.equal(invalid.DESKTOP_SESSION, undefined)
})
test('CDP discovery only accepts exact private-file port/browser shape', () => {
  assert.deepEqual(validateDebugPort('12345\n/devtools/browser/abc-123\n'), { port: 12345, browser: 'ws://127.0.0.1:12345/devtools/browser/abc-123' })
  for (const bad of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '1\nws://evil/', '1234\n/devtools/browser/a?token=x', '1234\n/devtools/browser/a\nextra']) {
    assert.throws(() => validateDebugPort(bad))
  }
})
test('API origin validation refuses foreign, credential-bearing and ambiguous endpoints', () => {
  assert.equal(validateLoopback('http://127.0.0.1:1234'), 'http://127.0.0.1:1234')
  for (const value of ['http://localhost:1234', 'https://127.0.0.1:1234', 'http://127.0.0.1',
    'http://secret@127.0.0.1:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234?token=secret']) {
    assert.throws(() => validateLoopback(value))
  }
})
function attestation() {
  return { ok: true, isPackaged: true, platform: 'linux', pid: 123, execPath: '/artifact/toolsenabled',
    resourcesPath: '/artifact/resources', appPath: '/artifact/resources/app.asar', userData: '/fresh/profile', version: '1.0.42',
    noSandboxSwitch: false, shellOrigin: 'http://127.0.0.1:1234', window: { url: 'http://127.0.0.1:1234/#/setup',
      visible: true, sandbox: true, contextIsolation: true, nodeIntegration: false } }
}
const expected = { artifact: '/artifact', userData: '/fresh/profile', pid: 123, version: '1.0.42', rendererUrl: 'http://127.0.0.1:1234/#/setup' }
test('runtime evidence must prove packaged exact identity and actual secure visible window', { skip: process.platform !== 'linux' ? 'Linux sealed proof uses Linux paths and launch environment' : false }, () => {
  assert.equal(assertAttestation(attestation(), expected).ok, true)
  for (const [key, value] of [['isPackaged', false], ['pid', 124], ['platform', 'win32'], ['execPath', '/other/toolsenabled'],
    ['resourcesPath', '/other/resources'], ['appPath', '/source/app'], ['userData', '/owner'], ['noSandboxSwitch', true]]) {
    assert.throws(() => assertAttestation({ ...attestation(), [key]: value }, expected), key)
  }
  for (const [key, value] of [['visible', false], ['sandbox', false], ['contextIsolation', false], ['nodeIntegration', true], ['url', 'http://127.0.0.1:9999/']]) {
    const actual = attestation(); actual.window[key] = value
    assert.throws(() => assertAttestation(actual, expected), key)
  }
  assert.throws(() => assertAttestation(null, expected))
})
test('build metadata needs both clean exact source refs, no override or unresolved payload', () => {
  const make = () => ({ schemaVersion: 2, ref: REF, dirty: false, overridden: false, dirtyFiles: [],
    app: { ref: REF, dirty: false }, payload: { ref: ENGINE, dirty: false, resolved: true } })
  const payload = { sourceRef: ENGINE }, options = { appRef: REF, engineRef: ENGINE }
  assertBuildMetadata(make(), payload, options)
  for (const [key, value] of [['dirty', true], ['overridden', true], ['ref', ENGINE], ['dirtyFiles', ['changed']]]) {
    assert.throws(() => assertBuildMetadata({ ...make(), [key]: value }, payload, options))
  }
  const unresolved = make(); unresolved.payload.resolved = false
  assert.throws(() => assertBuildMetadata(unresolved, payload, options))
  assert.throws(() => assertBuildMetadata(make(), { sourceRef: REF }, options))
})
test('normal fuse wire is required without modifying packaged executable', () => {
  const wire = { version: '1', 0: 49, 2: 48, 3: 48, 5: 49 }
  assert.equal(assertFusePolicy(wire).nodeCliInspector, false)
  for (const key of [0, 2, 3, 5]) assert.throws(() => assertFusePolicy({ ...wire, [key]: wire[key] === 49 ? 48 : 49 }))
})
test('process identity is real Linux generation metadata, not arbitrary PID liveness', { skip: process.platform !== 'linux' }, () => {
  assert.equal(processIdentity(process.pid).pid, process.pid)
  assert.match(processIdentity(process.pid).start, /^\d+$/)
  assert.throws(() => processIdentity(-1))
})
for (const file of ['fleet-profile-preload.cjs', 'preload.cjs']) test(`${file} executes and exposes runtimeIdentity with main argument refusal intact`, () => {
  const source = fs.readFileSync(new URL(`../../shell/${file}`, import.meta.url), 'utf8')
  const exposed = {}, calls = []
  const localRequire = createRequire(new URL('../../shell/preload.cjs', import.meta.url))
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } },
    ipcRenderer: new Proxy({}, { get: (_, key) => key === 'invoke' ? (...values) => { calls.push(values); return Promise.resolve({ ok: true }) }
      : key === 'sendSync' ? () => null : () => {} }) }
  const noop = () => {}
  vm.runInNewContext(source, { require: name => name === 'electron' ? electron : localRequire(name),
    window: { addEventListener: noop }, document: { addEventListener: noop },
    process: { platform: 'linux', env: {} }, console, setTimeout, clearTimeout, URL })
  assert.equal(typeof exposed.mcShell.runtimeIdentity, 'function')
  exposed.mcShell.runtimeIdentity()
  exposed.mcShell.runtimeIdentity('refuse-this')
  assert.deepEqual(calls.slice(-2).map(row => Array.from(row)), [['mc-runtime-identity'], ['mc-runtime-identity', 'refuse-this']])
})
test('main registers read-only reader with the actual owner top-frame guard and native window lookup', () => {
  const source = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const match = /ipcMain\.handle\('mc-runtime-identity', require\('\.\/runtime-identity\.cjs'\)\.createRuntimeIdentityReader\(\{[\s\S]*?\}\)\)/.exec(source)
  assert.ok(match)
  const readerFactory = createRequire(import.meta.url)('../../shell/runtime-identity.cjs').createRuntimeIdentityReader
  let handler
  const sender = { mainFrame: {}, isDestroyed: () => false, getLastWebPreferences: () => ({ sandbox: true }), getURL: () => 'http://127.0.0.1:1234/' }
  const window = { webContents: sender, isDestroyed: () => false, isVisible: () => true }
  let trusted = false, askedNative = false
  vm.runInNewContext(match[0], { ipcMain: { handle: (channel, fn) => { assert.equal(channel, 'mc-runtime-identity'); handler = fn } },
    require: name => { assert.equal(name, './runtime-identity.cjs'); return { createRuntimeIdentityReader: readerFactory } },
    app: { isPackaged: true, getAppPath: () => '/app/resources/app.asar', getPath: () => '/scratch', getVersion: () => '1', commandLine: { hasSwitch: () => false } },
    process: { pid: 123, platform: 'linux', execPath: '/app/toolsenabled', resourcesPath: '/app/resources' },
    BrowserWindow: { fromWebContents: value => { assert.equal(value, sender); askedNative = true; return window } },
    trustedFleetProfileSender: () => trusted, shellOrigin: 'http://127.0.0.1:1234' })
  const event = { sender, senderFrame: sender.mainFrame }
  assert.equal(handler(event).ok, false)
  assert.equal(askedNative, false)
  trusted = true
  assert.equal(handler(event).ok, true)
  assert.equal(askedNative, true)
  assert.equal(handler(event, {}).code, 'RUNTIME_IDENTITY_ARGUMENTS_REFUSED')
})

test('gate timeout has a bounded unknown-cleanup receipt when SIGTERM is ignored', async () => {
  const child = new EventEmitter(), signals = []
  child.pid = 12345
  child.kill = signal => { signals.push(signal); return true }
  child.unref = () => { child.detachedForReceipt = true }
  await assert.rejects(boundedGateChild(child, 'privacy-before', { timeoutMs: 5, cleanupMs: 5 }), error => {
    assert.equal(error.code, 'SEALED_GATE_CLEANUP_UNPROVEN_PRIVACY_BEFORE')
    assert.equal(error.ownedPid, 12345)
    return true
  })
  assert.deepEqual(signals, ['SIGTERM'])
  assert.equal(child.detachedForReceipt, true)
})
test('a gate that exits after timeout is still refused, not successful cleanup mistaken for pass', async () => {
  const child = new EventEmitter()
  child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); return true }
  child.unref = () => {}
  await assert.rejects(boundedGateChild(child, 'test', { timeoutMs: 5, cleanupMs: 100 }), { code: 'SEALED_GATE_REFUSED_TEST' })
})
test('owner socket shutdown proof distinguishes a real listener from gone socket', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-owner-socket-'))
  const pipeName = path.join(directory, 'owner.sock')
  const server = net.createServer(socket => socket.end())
  try {
    await new Promise(resolve => server.listen(pipeName, resolve))
    await assert.rejects(ownerSocketClosed({ pipeName }), { code: 'SEALED_OWNER_SOCKET_STILL_LISTENING' })
    await new Promise(resolve => server.close(resolve))
    const closed = await ownerSocketClosed({ pipeName })
    assert.equal(closed.listenerClosed, true)
    assert.equal(closed.observation, 'ENOENT')
  } finally { server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})
function apiInRenderer(fetchImpl, extra = {}) {
  return vm.runInNewContext(`(${rendererApiProbe.toString()})()`, {
    window: { mcShell: { getBridgeEndpoint: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:1234' }),
      getBridgeProof: async () => ({ ok: true, proof: 'PRIVATE_PROOF' }) } },
    fetch: fetchImpl, URL, AbortController, TextDecoder, Uint8Array, Promise, setTimeout, clearTimeout, ...extra,
  })
}
test('renderer-local API handshake has signal/deadline and never returns proof/token', async () => {
  let calls = 0
  const result = await apiInRenderer(async (url, init) => {
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.redirect, 'error')
    calls++
    if (calls === 1) return new Response(null, { status: 401 })
    if (calls === 2) {
      assert.equal(new URL(url).searchParams.get('proof'), 'PRIVATE_PROOF')
      return Response.json({ ok: true, token: 'PRIVATE_TOKEN' })
    }
    assert.equal(init.headers.authorization, 'Bearer PRIVATE_TOKEN')
    return Response.json({ ok: true, contract: { actions: [{ name: 'dispatch' }] } })
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 3)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
})
test('renderer rejects unexpectedly public API before requesting bootstrap credentials', async () => {
  let calls = 0
  const result = await apiInRenderer(async () => { calls++; return new Response(null, { status: 200 }) })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'unauthorized')
  assert.equal(calls, 1)
})
test('renderer API deadline cancels pending response read and bounds an ignored cancellation promise', async () => {
  let calls = 0, cancelled = 0, released = 0
  const result = await apiInRenderer(async () => {
    if (++calls === 1) return new Response(null, { status: 401 })
    return { status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}),
      cancel: () => { cancelled++; return new Promise(() => {}) }, releaseLock: () => { released++ } }) } }
  }, { setTimeout: callback => setTimeout(callback, 5) })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'bounded-request')
  assert.equal(cancelled, 1)
  assert.equal(released, 1)
})
test('renderer bounds an oversized JSON body before parsing or returning it', async () => {
  let calls = 0, cancelled = 0
  const result = await apiInRenderer(async () => {
    if (++calls === 1) return new Response(null, { status: 401 })
    return { status: 200, body: { getReader: () => ({ read: async () => ({ value: new Uint8Array(1024 * 1024 + 1), done: false }),
      cancel: async () => { cancelled++ }, releaseLock: () => {} }) } }
  })
  assert.equal(result.ok, false)
  assert.equal(cancelled, 1)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
})
