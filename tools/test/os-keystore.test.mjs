import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { platformKeystore } = require('../../shell/os-keystore.cjs')

function storage(backend, available = true) {
  const calls = []
  return {
    calls,
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) { this.calls.push('encrypt'); return Buffer.from(value) },
    decryptString(value) { this.calls.push('decrypt'); return value.toString() },
  }
}

test('Linux refuses plaintext, unknown, absent and unavailable secret backends before touching a secret', () => {
  for (const raw of [storage('basic_text'), storage('unknown'), storage(undefined),
    storage('new-unverified-backend'), storage('gnome_libsecret', false),
    { ...storage('gnome_libsecret'), getSelectedStorageBackend() { throw new Error('locked') } }]) {
    const guarded = platformKeystore(raw, { platform: 'linux' })
    assert.equal(guarded.isEncryptionAvailable(), false)
    assert.throws(() => guarded.encryptString('fixture'), { code: 'OS_KEYSTORE_UNAVAILABLE' })
    assert.throws(() => guarded.decryptString(Buffer.from('fixture')), { code: 'OS_KEYSTORE_UNAVAILABLE' })
    assert.deepEqual(raw.calls, [])
  }
})

test('Linux delegates to an available OS-backed keystore with its receiver intact', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const raw = storage(backend)
    const guarded = platformKeystore(raw, { platform: 'linux' })
    assert.equal(guarded.isEncryptionAvailable(), true)
    assert.equal(guarded.decryptString(guarded.encryptString('fixture')), 'fixture')
    assert.deepEqual(raw.calls, ['encrypt', 'decrypt'])
  }
})

test('keystore availability is rechecked on every encryption and decryption', () => {
  const raw = storage('gnome_libsecret')
  const guarded = platformKeystore(raw, { platform: 'linux' })
  assert.equal(guarded.isEncryptionAvailable(), true)
  raw.getSelectedStorageBackend = () => 'basic_text'
  assert.throws(() => guarded.encryptString('fixture'), { code: 'OS_KEYSTORE_UNAVAILABLE' })
  assert.deepEqual(raw.calls, [])
})

test('Windows and macOS receive their original keystore unchanged', () => {
  const raw = storage('unused')
  assert.equal(platformKeystore(raw, { platform: 'win32' }), raw)
  assert.equal(platformKeystore(raw, { platform: 'darwin' }), raw)
})
