import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createAccountStore } from '../../shell/product-account.cjs'
import { createRendererPrefs } from '../../shell/renderer-prefs.cjs'
import { readMetricsPreferences, saveMetricsPreferences, readMetricsScope, saveMetricsScope } from '../../src/metrics-preferences.js'

const script = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }
const password = 'local-only-metrics-test-password'

test('1/7/30-day choices and layouts survive relaunch and stay with their app account', async t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'metrics-preferences-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let account = createAccountStore({ directory, safeStorage })
  let prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  async function install() {
    let rehydrated
    const ready = new Promise(resolve => { rehydrated = resolve })
    const window = {
      document: { documentElement: { dataset: {} } }, CustomEvent: class { constructor(type) { this.type = type } },
      dispatchEvent: event => { if (event.type === 'mc:account-storage-rehydrated') rehydrated() },
      mcPrefs: { available: true, values: prefs.snapshot().values, write: (key, value) => prefs.set(key, value), remove: key => prefs.remove(key) },
      mcAccount: { current: async () => account.current(), data: async () => account.accountDataForRenderer(),
        getSetting: async key => account.getSetting(key), putSetting: async (key, value) => account.putSetting({ key, value }) },
    }
    vm.runInNewContext(script, { window })
    assert.equal(window.mcDurableStorage.accountReady, false)
    await ready
    assert.equal(window.mcDurableStorage.accountReady, true)
    return window.localStorage
  }
  for (const name of ['metrics-alpha', 'metrics-beta']) assert.equal((await account.createAccount({ username: name, displayName: name, password })).ok, true)
  assert.equal((await account.signIn({ username: 'metrics-alpha', password })).ok, true)
  const alphaId = account.current().account.id
  let storage = await install()
  assert.equal(readMetricsScope(storage), 'account')
  assert.equal(saveMetricsScope('computer', storage), true)
  const layout = JSON.stringify({ v: 1, rows: [['tokenflow'], ['models', 'turns']] })
  storage.setItem('mc.metrics.layout', layout)
  for (const range of ['24h', '7d', '30d']) {
    assert.equal(saveMetricsPreferences({ range, outcome: 'refused', order: 'oldest' }, storage), true)
    prefs = createRendererPrefs({ directory, fs, path, randomUUID })
    account = createAccountStore({ directory, safeStorage })
    storage = await install()
    assert.equal(readMetricsPreferences(storage).range, range)
    assert.equal(readMetricsScope(storage), 'computer')
    assert.equal(storage.getItem('mc.metrics.layout'), layout)
    assert.equal(account.getSetting('mc.metrics.view').value, storage.getItem('mc.metrics.view'))
  }
  account.signOut()
  assert.equal((await account.signIn({ username: 'metrics-beta', password })).ok, true)
  storage = await install()
  assert.deepEqual(readMetricsPreferences(storage), { range: '24h', outcome: 'all', order: 'newest' })
  assert.equal(readMetricsScope(storage), 'account', 'computer scope does not follow a different sign-in')
  assert.equal(storage.getItem('mc.metrics.layout'), null)
  assert.equal(saveMetricsPreferences({ range: '7d', outcome: 'all', order: 'newest' }, storage), true)
  account.signOut()
  const signedOut = await install()
  assert.equal(signedOut.getItem('mc.metrics.view'), null)
  assert.equal(signedOut.getItem('mc.metrics.layout'), null)
  assert.equal((await account.signIn({ username: 'metrics-alpha', password })).ok, true)
  storage = await install()
  assert.equal(readMetricsPreferences(storage).range, '30d')
  assert.equal(readMetricsScope(storage), 'computer')
  assert.equal(storage.getItem('mc.metrics.layout'), layout)
  assert.equal(prefs.snapshot().values['mc.metrics.layout'], undefined)
  assert.equal(prefs.snapshot().values[`acct:${alphaId}:mc.metrics.layout`], layout)
  assert.ok(fs.readFileSync(prefs.file, 'utf8').includes('mc.metrics.view'))
})

test('invalid settings recover to defaults and a refused write never claims it saved', () => {
  assert.deepEqual(readMetricsPreferences({ getItem: () => '{broken' }), { range: '24h', outcome: 'all', order: 'newest' })
  assert.equal(saveMetricsPreferences({ range: '30d' }, { setItem() { throw new Error('disk full') } }), false)
  assert.equal(readMetricsScope({ getItem: () => 'all-accounts' }), 'account')
  assert.equal(saveMetricsScope('computer', { setItem() { throw new Error('disk full') } }), false)
  assert.equal(saveMetricsScope('all-accounts', { setItem() { throw new Error('must not write invalid scope') } }), false)
})
