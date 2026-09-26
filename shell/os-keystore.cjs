'use strict'

// Electron can report encryption available on Linux while using basic_text,
// whose key is a hardcoded password, not an OS-protected secret. Keep the
// desktop's one keystore boundary fail-closed. Windows behavior is unchanged.
// https://www.electronjs.org/docs/latest/api/safe-storage
const LINUX_SECRET_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

function platformKeystore(storage, { platform = process.platform } = {}) {
  if (platform !== 'linux') return storage
  function isEncryptionAvailable() {
    try {
      return storage?.isEncryptionAvailable?.() === true
        && LINUX_SECRET_BACKENDS.has(storage.getSelectedStorageBackend?.())
    } catch { return false }
  }
  function requireKeystore() {
    if (!isEncryptionAvailable()) {
      const error = new Error('An OS-protected Linux keyring is unavailable. Secrets will not be persisted using a plaintext fallback.')
      error.code = 'OS_KEYSTORE_UNAVAILABLE'
      throw error
    }
  }
  return Object.freeze({
    isEncryptionAvailable,
    encryptString(value) { requireKeystore(); return storage.encryptString(value) },
    decryptString(value) { requireKeystore(); return storage.decryptString(value) },
  })
}

module.exports = { platformKeystore }
