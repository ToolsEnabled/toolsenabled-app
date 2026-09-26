import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const { createRuntimeIdentityReader } = createRequire(import.meta.url)('../../shell/runtime-identity.cjs')
function fixture() {
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false }
  const sender = { mainFrame: {}, isDestroyed: () => false, getLastWebPreferences: () => preferences,
    getURL: () => 'http://127.0.0.1:41234/#/setup' }
  const window = { webContents: sender, isDestroyed: () => false, isVisible: () => true }
  const event = { sender, senderFrame: sender.mainFrame }
  const dependencies = { app: { isPackaged: true, getAppPath: () => '/app/resources/app.asar',
    getPath: name => { assert.equal(name, 'userData'); return '/scratch/userdata' },
    getVersion: () => '1.0.42', commandLine: { hasSwitch: name => { assert.equal(name, 'no-sandbox'); return false } } },
    runtime: { pid: 123, platform: 'linux', execPath: '/app/toolsenabled', resourcesPath: '/app/resources', env: { SECRET: 'not returned' } },
    windowForSender: value => value === sender ? window : null, trustedSender: () => true,
    shellOrigin: () => 'http://127.0.0.1:41234' }
  return { event, dependencies, sender, window, preferences, read: createRuntimeIdentityReader(dependencies) }
}
test('runtime identity returns only current main-owned packaged evidence', () => {
  const f = fixture(), result = f.read(f.event)
  assert.equal(result.ok, true)
  assert.equal(result.isPackaged, true)
  assert.equal(result.window.sandbox, true)
  assert.equal(result.window.visible, true)
  assert.equal(result.noSandboxSwitch, false)
  assert.equal(result.execPath, '/app/toolsenabled')
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'isPackaged', 'platform', 'pid', 'execPath', 'resourcesPath',
    'appPath', 'userData', 'version', 'shellOrigin', 'noSandboxSwitch', 'window'].sort())
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.window))
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  f.preferences.sandbox = false
  assert.equal(f.read(f.event).window.sandbox, false, 'actual current preference, not an expected fixture value')
})
test('runtime identity rejects even undefined arguments before reading runtime', () => {
  const f = fixture()
  f.dependencies.app.getAppPath = () => { throw new Error('must not read') }
  assert.equal(f.read(f.event, undefined).code, 'RUNTIME_IDENTITY_ARGUMENTS_REFUSED')
})
for (const [name, mutate] of [
  ['untrusted sender', f => { f.dependencies.trustedSender = () => false }],
  ['subframe', f => { f.event.senderFrame = {} }],
  ['destroyed sender', f => { f.sender.isDestroyed = () => true }],
  ['destroyed window', f => { f.window.isDestroyed = () => true }],
  ['wrong window', f => { f.window.webContents = {} }],
]) test(`runtime identity refuses ${name}`, () => {
  const f = fixture(); mutate(f)
  assert.equal(createRuntimeIdentityReader(f.dependencies)(f.event).ok, false)
})
test('runtime identity never projects native errors or caller data', () => {
  const f = fixture()
  f.sender.getLastWebPreferences = () => { throw new Error('private-token-not-for-output') }
  assert.deepEqual(f.read(f.event), { ok: false, code: 'RUNTIME_IDENTITY_UNAVAILABLE' })
})
test('runtime identity rechecks owner and frame after collecting evidence', () => {
  const f = fixture()
  f.dependencies.app.getVersion = () => { f.event.senderFrame = {}; return '1' }
  assert.equal(f.read(f.event).ok, false)
})
