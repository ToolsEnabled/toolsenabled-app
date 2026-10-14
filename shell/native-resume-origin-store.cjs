'use strict'

// Private host observations, never renderer-supplied paths. One small record
// per native session makes an exact saved selector survive a full app quit.
// The record holds identity and directory names only; it never opens sign-in
// files or stores credential material.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const MAX_RECORD_BYTES = 16 * 1024
const refusal = () => Object.assign(new Error('The original sign-in home for this saved conversation could not be verified.'),
  { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
const storageRefusal = () => Object.assign(new Error('ToolsEnabled could not save the sign-in home needed to reopen this conversation.'),
  { code: 'AGENT_RESUME_ORIGIN_STORAGE_FAILED' })
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value)
function valid(record, sessionId) {
  return record?.version === 1 && record.sessionId === sessionId && text(sessionId, 128)
    && text(record.threadId, 512) && ['claude', 'codex', 'gemini'].includes(record.provider)
    && (record.account === null || text(record.account, 128))
    && (record.agentId === null || text(record.agentId, 512))
    && text(record.home, 4096) && path.isAbsolute(record.home)
    && (record.databaseHome === null || text(record.databaseHome, 4096) && path.isAbsolute(record.databaseHome))
}
function createNativeResumeOriginStore({ directory } = {}) {
  if (!text(directory, 4096) || !path.isAbsolute(directory)) throw refusal()
  const fileFor = sessionId => {
    if (!text(sessionId, 128)) throw refusal()
    return path.join(directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  }
  const assertDirectory = () => {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal()
  }
  return {
    get(sessionId) {
      const file = fileFor(sessionId)
      let fd
      try {
        assertDirectory()
        if (fs.lstatSync(file).isSymbolicLink()) throw refusal()
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw refusal()
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0)
        if (count > MAX_RECORD_BYTES) throw refusal()
        const record = JSON.parse(buffer.subarray(0, count).toString('utf8'))
        if (!valid(record, sessionId)) throw refusal()
        return Object.freeze({ threadId: record.threadId, provider: record.provider, account: record.account,
          agentId: record.agentId, home: record.home, databaseHome: record.databaseHome })
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw refusal()
      } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch { throw refusal() } } }
    },
    set(sessionId, origin) {
      const file = fileFor(sessionId)
      const record = { version: 1, sessionId, threadId: origin.threadId, provider: origin.provider,
        account: origin.account, agentId: origin.agentId, home: origin.home, databaseHome: origin.databaseHome }
      if (!valid(record, sessionId)) throw refusal()
      const bytes = JSON.stringify(record)
      if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw refusal()
      const temporary = file + '.' + randomUUID() + '.tmp'
      let fd
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        assertDirectory()
        // Refuse a substituted record rather than following or replacing a link.
        try { if (fs.lstatSync(file).isSymbolicLink()) throw refusal() } catch (error) { if (error.code !== 'ENOENT') throw error }
        fd = fs.openSync(temporary, 'wx', 0o600)
        fs.writeFileSync(fd, bytes)
        fs.fsyncSync(fd)
        fs.closeSync(fd); fd = undefined
        fs.renameSync(temporary, file)
      } catch { throw storageRefusal() }
      finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch { throw storageRefusal() } }
        try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw storageRefusal() }
      }
    },
  }
}
module.exports = { createNativeResumeOriginStore }
