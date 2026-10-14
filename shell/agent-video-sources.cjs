'use strict'
/* WHICH WINDOW EACH AGENT'S VIDEO SHOWED, REMEMBERED ACROSS A RESTART (1.0.49).
 *
 * The owner, 2026-09-26: a video pick is remembered across restarts, with a
 * one-click re-pick. A window id cannot be what is remembered: ids do not
 * survive a restart, and X11 reuses them (one id belonged to five different
 * windows during the spike). So a record keeps the window's title and program
 * name, and nothing ever streams from a record. After a restart the person
 * picks again, with the best title match pre-selected.
 *
 * Shell-owned, like screen-control-permissions.cjs. The renderer never writes
 * this file and never supplies a title: shell/video-box-host.cjs saves the
 * name of the window its own display handler granted.
 *
 *   <userData>/agent-video-sources.json, mode 0600, at most 32 records and
 *   64 KB, never a symbolic link, exactly one hard link, replaced atomically.
 *
 * Each record is bound to the node identity (treeId, nodeId, nodeCreatedAt),
 * the same identity main.cjs screenIdentityFrom() checks. A record whose node
 * is gone, or whose node id now belongs to a re-created node, is dropped when
 * the list is read.
 *
 * Titles are private. Nothing in this file logs one or puts one in an error.
 * "Delete agent nodes when the app exits" (node-privacy-cleanup.cjs) and Erase
 * remove the file with the other node data; clearForPrivacy() and
 * confirmCleared() are that removal and its read-back.
 */
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const FILE_NAME = 'agent-video-sources.json'
const MAX_BYTES = 64 * 1024
const MAX_RECORDS = 32
const FIELDS = Object.freeze(['treeId', 'nodeId', 'nodeCreatedAt', 'title', 'app', 'savedAt'])
// [shortest, longest] in UTF-16 units. A window may have no title or no program name.
const LENGTHS = Object.freeze({ treeId: [1, 200], nodeId: [1, 200], nodeCreatedAt: [1, 200],
  title: [0, 300], app: [0, 80], savedAt: [1, 40] })
const TEMPORARY = /^agent-video-sources\.json\.[0-9a-f-]{36}\.tmp$/
const CONTROL = /[\u0000-\u001f\u007f]/

const MESSAGES = Object.freeze({
  VIDEO_SAVED_UNREADABLE: 'The saved video choices could not be read. Turn off all video to clear them.',
  VIDEO_SAVED_WRITE_FAILED: 'This video choice could not be saved, so it will not come back after a restart.',
  VIDEO_SAVED_CLOSED: 'Video choices cannot be saved while the app is closing or after its data was erased.',
})
function problem(code) {
  return Object.assign(new Error(MESSAGES[code]), { code })
}

function validRecord(record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).length === FIELDS.length
    && FIELDS.every(key => typeof record[key] === 'string'
      && record[key].length >= LENGTHS[key][0] && record[key].length <= LENGTHS[key][1]
      && !CONTROL.test(record[key]))
}
function validRecords(records) {
  return Array.isArray(records) && records.length <= MAX_RECORDS && records.every(validRecord)
    && new Set(records.map(record => record.nodeId)).size === records.length
}

/* A window title is text another program chose. Control characters become
   spaces, and a title longer than a record allows is cut without splitting a
   surrogate pair. */
function cleanTitle(value, limit = LENGTHS.title[1]) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (text.length > limit) {
    text = text.slice(0, limit)
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1)
  }
  return text
}

function createAgentVideoSources({ directory, io = fs, now = () => new Date(), sealed = () => false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('The video choice store needs an absolute directory.')
  const file = path.join(directory, FILE_NAME)
  // Set by the quit-time privacy cleanup: nothing may be saved after it ran.
  let closed = false
  const writable = () => !closed && sealed() !== true

  function syncDirectory() {
    if (process.platform === 'win32') return
    const fd = io.openSync(directory, 'r')
    try { io.fsyncSync(fd) } finally { io.closeSync(fd) }
  }
  // lstat, then open without following, then prove the opened file is the
  // one lstat saw: a plain file, one link, this user's, private.
  function checkedOpen() {
    const before = io.lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw problem('VIDEO_SAVED_UNREADABLE')
    const fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0))
    try {
      const current = io.fstatSync(fd)
      if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1
          || (process.platform !== 'win32' && (current.uid !== process.getuid() || (current.mode & 0o077)))) {
        throw problem('VIDEO_SAVED_UNREADABLE')
      }
      return fd
    } catch (error) { io.closeSync(fd); throw error }
  }
  function read() {
    let fd
    try {
      fd = checkedOpen()
      const size = io.fstatSync(fd).size
      if (size === 0) return [] // What a failed save leaves: no choices, never an older one.
      if (size > MAX_BYTES) throw problem('VIDEO_SAVED_UNREADABLE')
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let count = 0, got
      do { got = io.readSync(fd, bytes, count, bytes.length - count, count); count += got } while (got && count < bytes.length)
      if (count > MAX_BYTES) throw problem('VIDEO_SAVED_UNREADABLE')
      const parsed = JSON.parse(bytes.subarray(0, count).toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || Object.keys(parsed).length !== 2
          || !validRecords(parsed.sources)) throw problem('VIDEO_SAVED_UNREADABLE')
      return parsed.sources.map(record => ({ ...record }))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw problem('VIDEO_SAVED_UNREADABLE')
    } finally { if (fd !== undefined) io.closeSync(fd) }
  }
  function removeTemporaries({ settledMs = 0 } = {}) {
    let names
    try { names = io.readdirSync(directory) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
    for (const name of names) {
      if (!TEMPORARY.test(name)) continue
      const target = path.join(directory, name)
      // At open, a copy younger than settledMs may be the running app's save in flight.
      if (settledMs > 0 && now().getTime() - io.lstatSync(target).mtimeMs < settledMs) continue
      io.unlinkSync(target)
    }
  }
  /* A hard kill between writing the half-written copy and renaming it leaves
     that copy, with every saved title, behind. The next launch and every
     later save or turn-off remove it; failing to never fails the save. */
  function tidyTemporaries() {
    try { removeTemporaries() } catch { /* the privacy cleanup removes them and checks */ }
  }
  // unlink removes a symbolic link itself, never what it points at.
  function removeFile() {
    let stat
    try { stat = io.lstatSync(file) } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
    if (stat.isDirectory()) throw problem('VIDEO_SAVED_UNREADABLE')
    io.unlinkSync(file)
    return true
  }
  /* A save that fails must not leave an older choice to come back, least of
     all one the person just turned off. The existing plain file is emptied
     instead, which reads as "no choices". */
  function invalidate() {
    try {
      const fd = checkedOpen()
      io.closeSync(fd)
      const writableFd = io.openSync(file, io.constants.O_WRONLY | (io.constants.O_NOFOLLOW || 0))
      try { io.ftruncateSync(writableFd, 0); io.fsyncSync(writableFd) } finally { io.closeSync(writableFd) }
    } catch { /* Nothing readable is left to invalidate. */ }
  }
  function replace(records) {
    if (!writable()) throw problem('VIDEO_SAVED_CLOSED')
    if (!validRecords(records)) throw problem('VIDEO_SAVED_WRITE_FAILED')
    if (!records.length) {
      try { if (removeFile()) syncDirectory() } catch { invalidate(); throw problem('VIDEO_SAVED_WRITE_FAILED') }
      tidyTemporaries()
      return
    }
    const text = JSON.stringify({ version: 1, sources: records }) + '\n'
    if (Buffer.byteLength(text) > MAX_BYTES) throw problem('VIDEO_SAVED_WRITE_FAILED')
    let fd, temporary = path.join(directory, FILE_NAME + '.' + randomUUID() + '.tmp')
    try {
      // Only a plain file of ours is ever replaced; a link in its place is refused.
      try { io.closeSync(checkedOpen()) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      fd = io.openSync(temporary, 'wx', 0o600)
      io.writeFileSync(fd, text, 'utf8')
      io.fsyncSync(fd)
      io.closeSync(fd); fd = undefined
      if (!writable()) throw problem('VIDEO_SAVED_CLOSED')
      io.renameSync(temporary, file); temporary = null
      syncDirectory()
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd) } catch {} }
      if (temporary) { try { io.unlinkSync(temporary) } catch {} }
      invalidate()
      throw problem(error?.code === 'VIDEO_SAVED_CLOSED' ? 'VIDEO_SAVED_CLOSED' : 'VIDEO_SAVED_WRITE_FAILED')
    }
    tidyTemporaries()
  }
  /* A launch that loses the single-instance lock builds this store too, before it
     hands over (shell/main.cjs builds it at load), and every tree-node command
     arrives as one. Removing every copy here deleted the running app's save
     between its write and its rename, and that save then emptied the file. So
     opening removes only a copy old enough to be a hard kill's; every later save
     or turn-off still removes any. */
  const SETTLED_MS = 60_000
  try { removeTemporaries({ settledMs: SETTLED_MS }) } catch { /* as tidyTemporaries() */ }

  return {
    file,
    /* Saves one agent's choice, replacing any earlier one for that node. The
       oldest choice makes room once 32 are saved. */
    remember({ treeId, nodeId, nodeCreatedAt, title, app }) {
      if (!writable()) throw problem('VIDEO_SAVED_CLOSED')
      const entry = { treeId, nodeId, nodeCreatedAt, title: cleanTitle(title), app: cleanTitle(app, LENGTHS.app[1]),
        savedAt: now().toISOString() }
      if (!validRecord(entry)) throw problem('VIDEO_SAVED_WRITE_FAILED')
      const others = read().filter(record => record.nodeId !== nodeId)
      others.sort((left, right) => left.savedAt.localeCompare(right.savedAt))
      while (others.length >= MAX_RECORDS) others.shift()
      replace([...others, entry])
      return { ...entry }
    },
    /* Turning one agent's video off forgets its choice. An unreadable file
       cannot be edited, so it is removed whole: the title must go. */
    forget(nodeId) {
      let current
      try { current = read() } catch {
        if (removeFile()) syncDirectory()
        tidyTemporaries()
        return
      }
      if (!current.some(record => record.nodeId === nodeId)) { tidyTemporaries(); return }
      if (!writable()) { tidyTemporaries(); return }
      replace(current.filter(record => record.nodeId !== nodeId))
    },
    // "Turn off all video": every choice goes, readable or not.
    clear() {
      if (removeFile()) syncDirectory()
      removeTemporaries()
    },
    /* The saved choices whose node still exists with the same identity.
       identityOf(nodeId) answers { treeId, nodeId, nodeCreatedAt } or null.
       The rest are dropped from the file; a failed drop still answers only
       the kept ones. */
    list(identityOf) {
      const current = read()
      const kept = current.filter(record => {
        let identity = null
        try { identity = identityOf(record.nodeId) } catch { identity = null }
        return Boolean(identity) && identity.nodeId === record.nodeId && identity.treeId === record.treeId
          && String(identity.nodeCreatedAt) === record.nodeCreatedAt
      })
      if (kept.length !== current.length && writable()) {
        try { replace(kept) } catch { /* replace() already emptied the file */ }
      }
      return kept.map(record => ({ ...record }))
    },
    /* The node privacy cleanup. close: true is the quit, after which nothing
       may be saved again in this process. Errors propagate: the cleanup
       keeps its barrier and runs again at the next launch. */
    clearForPrivacy({ close = false } = {}) {
      if (close) closed = true
      if (removeFile()) syncDirectory()
      removeTemporaries()
      return { ok: true, cleared: true }
    },
    // Read-back for the privacy cleanup: no file and no half-written copy.
    confirmCleared() {
      try { io.lstatSync(file); return false } catch (error) { if (error?.code !== 'ENOENT') return false }
      try { return !io.readdirSync(directory).some(name => TEMPORARY.test(name)) }
      catch (error) { return error?.code === 'ENOENT' }
    },
  }
}

module.exports = { createAgentVideoSources, cleanTitle, validRecords, FILE_NAME, MAX_RECORDS }
