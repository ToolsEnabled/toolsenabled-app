'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const LIMIT = 8192
function createHostedSessionStorage({ directory, safeStorage }) {
  function location(name = 'hosted-session.enc') {
    const root = path.resolve(typeof directory === 'function' ? directory() : directory)
    const resolved = fs.realpathSync.native(root)
    if (process.platform === 'win32' ? resolved.toLowerCase() !== root.toLowerCase() : resolved !== root) throw new Error('Session directory is redirected')
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Session directory is invalid')
    return path.join(root, name)
  }
  function inspect(file) {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT) throw new Error('Session file is invalid')
      if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Error('Session file is not private')
      return stat
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  function available() { return safeStorage?.isEncryptionAvailable?.() === true }
  function installationId() {
    // This non-secret UUID selects the session slot on fresh password login.
    // It does not authenticate a request or identify an enrolled computer.
    const file = location('hosted-installation-id')
    if (!inspect(file)) {
      let fd
      try {
        fd = fs.openSync(file, 'wx', 0o600)
        fs.writeFileSync(fd, crypto.randomUUID(), 'utf8')
        fs.fsyncSync(fd)
      } catch (error) { if (error.code !== 'EEXIST') throw error }
      finally { if (fd !== undefined) fs.closeSync(fd) }
    }
    inspect(file)
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 36
          || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error('Invalid installation file')
      const value = fs.readFileSync(fd, 'utf8')
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error('Invalid installation identifier')
      return value
    } finally { fs.closeSync(fd) }
  }
  function readAvailable() {
    const file = location()
    if (!inspect(file)) return { status: 'absent' }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT
          || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error('Session file changed')
      return { status: 'present', value: JSON.parse(safeStorage.decryptString(fs.readFileSync(fd))) }
    } finally { fs.closeSync(fd) }
  }
  function read() {
    if (!available()) return null
    const result = readAvailable()
    return result.status === 'present' ? result.value : null
  }
  // Internal storage observation keeps absence distinct from an unreadable
  // credential. The caller must project status; retained bytes stay private.
  function observe() {
    try {
      if (!available()) return { status: 'unavailable' }
      return readAvailable()
    } catch { return { status: 'unavailable' } }
  }
  function write(value) {
    if (!available()) return false
    const bytes = safeStorage.encryptString(JSON.stringify(value))
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new Error('Invalid encrypted session')
    const file = location()
    inspect(file)
    const temporary = `${file}.tmp-${crypto.randomBytes(16).toString('hex')}`
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, bytes)
      fs.fsyncSync(fd)
    } catch (error) {
      fs.closeSync(fd)
      try { fs.unlinkSync(temporary) } catch {}
      throw error
    }
    fs.closeSync(fd)
    try {
      if (location() !== file) throw new Error('Session location changed')
      inspect(file)
      fs.renameSync(temporary, file)
      return true
    } finally { try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  function clear() {
    const file = location()
    if (inspect(file)) fs.unlinkSync(file)
    return true
  }
  return Object.freeze({ read, observe, write, clear, installationId })
}
module.exports = { createHostedSessionStorage }
