'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const MAX_BYTES = 64 * 1024
const fields = ['computerId', 'treeId', 'nodeId', 'nodeCreatedAt', 'agentId', 'roleId', 'label']
const problem = () => Object.assign(new Error('Remembered access is off in this app. The saved choice could not be read or saved. Check it before reopening the app.'), { code: 'SCREEN_PERMISSION_STORAGE_FAILED' })
function validRecords(records) {
  return Array.isArray(records) && records.length <= 32 && records.every(record => record && typeof record === 'object'
    && Object.keys(record).length === fields.length && fields.every(key => typeof record[key] === 'string'
      && record[key].length > 0 && record[key].length <= (key === 'label' ? 80 : 200) && !/[\u0000-\u001f\u007f]/.test(record[key])))
    && new Set(records.map(record => JSON.stringify(fields.slice(0, -1).map(key => record[key])))).size === records.length
}
// Shell-owned authority, separate from renderer-writable preferences. Revoke
// the old record durably before replacing it: a failed/partial write can lose
// permission, but cannot revive an earlier allowed set after Stop all.
function createScreenControlPermissions({ directory, io = fs } = {}) {
  const file = path.join(directory, 'screen-control-permissions.json')
  function checkedOpen() {
    const before = io.lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw problem()
    const fd = io.openSync(file, io.constants.O_RDWR | (io.constants.O_NOFOLLOW || 0))
    try {
      const current = io.fstatSync(fd)
      if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1
          || (process.platform !== 'win32' && (current.uid !== process.getuid() || (current.mode & 0o077)))) throw problem()
      return fd
    } catch (error) { io.closeSync(fd); throw error }
  }
  function read() {
    let fd
    try {
      fd = checkedOpen()
      const size = io.fstatSync(fd).size
      if (size === 0) return [] // A durable revocation has no authority.
      if (size > MAX_BYTES) throw problem()
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let count = 0, read
      do { read = io.readSync(fd, bytes, count, bytes.length - count, count); count += read } while (read && count < bytes.length)
      if (count > MAX_BYTES) throw problem()
      const parsed = JSON.parse(bytes.subarray(0, count).toString('utf8'))
      if (parsed?.version !== 1 || Object.keys(parsed).length !== 2 || !validRecords(parsed.agents)) throw problem()
      return parsed.agents
    } catch (error) { if (error.code === 'ENOENT') return []; throw problem() }
    finally { if (fd !== undefined) io.closeSync(fd) }
  }
  function write(records) {
    if (!validRecords(records)) throw problem()
    const text = JSON.stringify({ version: 1, agents: records }) + '\n'
    if (Buffer.byteLength(text) > MAX_BYTES) throw problem()
    let fd, temporary
    try {
      try { fd = checkedOpen() }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        fd = io.openSync(file, 'wx', 0o600)
      }
      io.ftruncateSync(fd, 0)
      io.fsyncSync(fd)
      io.closeSync(fd); fd = undefined
      if (!records.length) return
      temporary = file + '.' + randomUUID() + '.tmp'
      fd = io.openSync(temporary, 'wx', 0o600)
      io.writeFileSync(fd, text, 'utf8'); io.fsyncSync(fd)
      io.closeSync(fd); fd = undefined
      io.renameSync(temporary, file); temporary = null
      if (process.platform !== 'win32') {
        fd = io.openSync(directory, 'r'); io.fsyncSync(fd)
      }
    } catch {
      // A failure after rename must not leave a newly granted choice behind
      // when its caller was told admission failed. Best-effort invalidation
      // also handles a filesystem that became unwritable mid-operation.
      if (fd !== undefined) { try { io.closeSync(fd) } catch {}; fd = undefined }
      try { const revoked = checkedOpen(); try { io.ftruncateSync(revoked, 0); io.fsyncSync(revoked) } finally { io.closeSync(revoked) } } catch {}
      throw problem()
    }
    finally {
      if (fd !== undefined) io.closeSync(fd)
      if (temporary) { try { io.unlinkSync(temporary) } catch {} }
    }
  }
  return { read, write }
}
module.exports = { createScreenControlPermissions, validRecords }
