/* Outside control, the shell's half: the engine's decision becomes Electron's
 * command-line switch exactly once, before ready, and never a throw.
 *
 * The last test reads the packed payload this checkout ships, because the row
 * lives in three places that must agree: the engine registry (row + plain
 * name), the shell's writable list, and the payload manifest that stages the
 * enforcer module into the copy a person runs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  OUTSIDE_CONTROL_MODULE,
  PORT_SWITCH,
  ADDRESS_SWITCH,
  resolveOutsideControl,
  applyOutsideControl,
  startOutsideControl,
} = require_(path.join(REPO, 'shell', 'outside-control.cjs'))

const SETTING_ID = 'app.outside_control'

function fakeCommandLine(initial = {}) {
  const switches = new Map(Object.entries(initial))
  return {
    switches,
    hasSwitch: name => switches.has(name),
    getSwitchValue: name => switches.get(name) ?? '',
    appendSwitch: (name, value) => { switches.set(name, value) },
  }
}

const policyModule = decision => ({ outsideControlPolicy: () => decision })

test('no payload, no module, a module without the function, and a throwing policy each shut the port with a code', () => {
  const absent = resolveOutsideControl({ root: null })
  assert.equal(absent.available, false)
  assert.equal(absent.enabled, false)
  assert.equal(absent.code, 'OUTSIDE_CONTROL_PAYLOAD_ABSENT')

  const missing = resolveOutsideControl({ root: 'C:\\x', load: () => { throw new Error('Cannot find module') } })
  assert.equal(missing.code, 'OUTSIDE_CONTROL_MODULE_ABSENT')
  assert.match(missing.reason, /src\/lib\/outside-control\.js/)

  const wrong = resolveOutsideControl({ root: 'C:\\x', load: () => ({}) })
  assert.equal(wrong.code, 'OUTSIDE_CONTROL_MODULE_INVALID')

  const broken = resolveOutsideControl({ root: 'C:\\x', load: () => ({ outsideControlPolicy() { throw new Error('disk gone') } }) })
  assert.equal(broken.code, 'OUTSIDE_CONTROL_UNREADABLE')
  assert.match(broken.reason, /disk gone/)
  for (const answer of [absent, missing, wrong, broken]) assert.equal(answer.enabled, false)
})

test('the engine\'s decision is carried through: off stays off with its reason, chosen opens with port and address', () => {
  const loaded = []
  const load = file => { loaded.push(file); return policyModule({ enabled: false, port: 9223, address: '127.0.0.1', reason: 'not-chosen', source: 'default' }) }
  const off = resolveOutsideControl({ root: 'C:\\payload', load })
  assert.deepEqual(off, { available: true, enabled: false, port: 9223, address: '127.0.0.1', code: null, reason: 'not-chosen', source: 'default' })
  assert.equal(loaded[0], path.join('C:\\payload', OUTSIDE_CONTROL_MODULE))

  const on = resolveOutsideControl({ root: 'C:\\payload', load: () => policyModule({ enabled: true, port: 9223, address: '127.0.0.1', reason: 'chosen', source: 'user' }) })
  assert.deepEqual(on, { available: true, enabled: true, port: 9223, address: '127.0.0.1', code: null, reason: 'chosen', source: 'user' })

  const odd = resolveOutsideControl({ root: 'C:\\payload', load: () => policyModule({ enabled: true, port: '9223' }) })
  assert.equal(odd.enabled, true)
  assert.equal(odd.port, null, 'a port that is not an integer is not a port')
})

test('applying: off appends nothing; on appends the port and the loopback address; a port on the command line wins', () => {
  const off = fakeCommandLine()
  assert.deepEqual(applyOutsideControl(off, { enabled: false, port: 9223 }), { applied: false, why: 'off', port: null })
  assert.equal(off.switches.size, 0)

  const on = fakeCommandLine()
  assert.deepEqual(applyOutsideControl(on, { enabled: true, port: 9223, address: '127.0.0.1' }), { applied: true, why: 'setting', port: 9223 })
  assert.equal(on.getSwitchValue(PORT_SWITCH), '9223')
  assert.equal(on.getSwitchValue(ADDRESS_SWITCH), '127.0.0.1')

  const noPort = fakeCommandLine()
  assert.deepEqual(applyOutsideControl(noPort, { enabled: true, port: null }), { applied: false, why: 'off', port: null }, 'on without a usable port opens nothing')
  assert.equal(noPort.switches.size, 0)

  const named = fakeCommandLine({ [PORT_SWITCH]: '9333' })
  assert.deepEqual(applyOutsideControl(named, { enabled: true, port: 9223, address: '127.0.0.1' }), { applied: false, why: 'command-line', port: 9333 })
  assert.equal(named.getSwitchValue(PORT_SWITCH), '9333', 'the named port is left alone')
  assert.equal(named.hasSwitch(ADDRESS_SWITCH), false)

  const namedOff = fakeCommandLine({ [PORT_SWITCH]: 'abc' })
  assert.deepEqual(applyOutsideControl(namedOff, { enabled: false }), { applied: false, why: 'command-line', port: null })
})

test('startOutsideControl() is decide-then-apply, one frozen account of both', () => {
  const commandLine = fakeCommandLine()
  const account = startOutsideControl(commandLine, { root: 'C:\\payload', load: () => policyModule({ enabled: true, port: 9223, address: '127.0.0.1', reason: 'chosen', source: 'user' }) })
  assert.equal(account.enabled, true)
  assert.equal(account.applied, true)
  assert.equal(account.why, 'setting')
  assert.equal(account.port, 9223)
  assert.ok(Object.isFrozen(account))
  assert.equal(commandLine.getSwitchValue(PORT_SWITCH), '9223')

  const shut = startOutsideControl(fakeCommandLine(), { root: null })
  assert.equal(shut.enabled, false)
  assert.equal(shut.applied, false)
  assert.equal(shut.code, 'OUTSIDE_CONTROL_PAYLOAD_ABSENT')
})

test('the packed payload, the shell\'s writable list and the manifest agree on the row', () => {
  const payload = path.join(REPO, 'capability')
  const policy = require_(path.join(payload, OUTSIDE_CONTROL_MODULE))
  assert.equal(typeof policy.outsideControlPolicy, 'function', 'the payload carries the enforcer')
  assert.equal(policy.SETTING_ID, SETTING_ID)
  const registry = JSON.parse(fs.readFileSync(path.join(payload, 'config', 'settings-registry.json'), 'utf8'))
  const row = registry.entries.find(entry => entry.id === SETTING_ID)
  assert.ok(row, 'the payload registry declares the row')
  assert.equal(row.default, false, 'a public copy ships with the port shut')
  assert.equal(row.control, 'toggle')
  assert.equal(typeof registry.titles[SETTING_ID], 'string')
  const shell = require_(path.join(REPO, 'shell', 'product-settings.cjs'))
  assert.ok(shell.WRITABLE_IDS.includes(SETTING_ID), 'the settings page may write it')
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  assert.ok(manifest.hostModules.includes(OUTSIDE_CONTROL_MODULE), 'the manifest stages the enforcer into the payload')
  /* The real decision on this checkout's own settings: never a throw. */
  const decision = resolveOutsideControl({ root: payload })
  assert.equal(decision.available, true)
  assert.equal(typeof decision.enabled, 'boolean')
})
