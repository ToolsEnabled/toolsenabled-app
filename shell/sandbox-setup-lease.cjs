'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
function fail(code) { throw Object.assign(new Error('Sandbox preparation coordination could not be established.'), { code }) }
const identity = s => `${s.dev}:${s.ino}`
// Linux coordination is deliberately conservative across local rootless
// daemons: one preparation per OS user, plus a profile journal. No PID-based
// stale lock reclamation can prove a Docker build has finished.
function acquireSandboxPreparation({ stateRoot, platform = process.platform,
  uid = process.getuid?.(), runtimeRoot = platform === 'linux' ? `/run/user/${uid}` : null,
  bootId = platform === 'linux' ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null } = {}) {
  if (platform !== 'linux') fail('SANDBOX_SETUP_COORDINATION_UNSUPPORTED')
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^[a-f0-9-]{36}$/.test(bootId || '')) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
  function root(dir, privateOnly = false) {
    if (!path.isAbsolute(dir || '') || fs.realpathSync(dir) !== path.resolve(dir)) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    const st = fs.lstatSync(dir, { bigint: true })
    if (!st.isDirectory() || st.uid !== BigInt(uid) || (st.mode & BigInt(privateOnly ? 0o077 : 0o022))) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(st)) { fs.closeSync(fd); fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE') }
    return fd
  }
  const rootFds = []
  try { rootFds.push(root(stateRoot)); rootFds.push(root(runtimeRoot, true)) }
  catch (error) { for (const fd of rootFds) fs.closeSync(fd); throw error }
  const held = []
  let buildStarted = false
  const token = crypto.randomUUID()
  function journalStat(st) {
    if (!st.isDirectory() || st.uid !== BigInt(uid) || (st.mode & 0o077n)) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
  }
  function assertRootsCurrent() {
    for (const [index, dir] of [stateRoot, runtimeRoot].entries()) {
      const named = fs.lstatSync(dir, { bigint: true }), opened = fs.fstatSync(rootFds[index], { bigint: true })
      if (fs.realpathSync(dir) !== path.resolve(dir) || !named.isDirectory() || named.uid !== BigInt(uid)
          || (named.mode & BigInt(index === 1 ? 0o077 : 0o022)) || identity(named) !== identity(opened)) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    }
  }
  function readRecord(directoryFd) {
    let fd
    try {
      fd = fs.openSync(`/proc/self/fd/${directoryFd}/record.json`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      const s = fs.fstatSync(fd)
      if (!s.isFile() || s.size > 4096 || s.uid !== uid || (s.mode & 0o077)) fail('SANDBOX_SETUP_JOURNAL_UNREADABLE')
      const record = JSON.parse(fs.readFileSync(fd, 'utf8'))
      if (record?.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.bootId || '') || !/^[a-f0-9-]{36}$/.test(record.token || '')) fail('SANDBOX_SETUP_JOURNAL_UNREADABLE')
      return record
    } catch { fail('SANDBOX_SETUP_JOURNAL_UNREADABLE') }
    finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  function remove(entry) {
    const st = fs.lstatSync(entry.dir, { bigint: true })
    if (identity(st) !== entry.identity || st.uid !== BigInt(uid) || !st.isDirectory()) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    const directoryFd = fs.openSync(entry.dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
    if (identity(fs.fstatSync(directoryFd, { bigint: true })) !== entry.identity) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    const anchored = `/proc/self/fd/${directoryFd}`
    const files = fs.readdirSync(anchored)
    if (files.length !== 1 || files[0] !== 'record.json') fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    const file = path.join(anchored, 'record.json')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let record
    try { const s = fs.fstatSync(fd); if (!s.isFile() || s.size > 4096 || s.uid !== uid) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE'); record = JSON.parse(fs.readFileSync(fd, 'utf8')) } finally { fs.closeSync(fd) }
    if (record.token !== entry.token) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    fs.unlinkSync(file)
    if (identity(fs.lstatSync(entry.dir, { bigint: true })) !== entry.identity) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
    fs.rmdirSync(entry.dir)
    } finally { fs.closeSync(directoryFd) }
  }
  function acquire(parent, name) {
    const dir = path.join(parent, name)
    try { fs.mkdirSync(dir, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const st = fs.lstatSync(dir, { bigint: true })
      if (!st.isDirectory() || st.uid !== BigInt(uid) || (st.mode & 0o077n)) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
      const oldDir = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      let old
      try {
        if (identity(fs.fstatSync(oldDir, { bigint: true })) !== identity(st)) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
        old = readRecord(oldDir)
      } finally { fs.closeSync(oldDir) }
      if (old.bootId === bootId) fail('SANDBOX_SETUP_RECOVERY_REQUIRED')
      // A different verified kernel boot means no old daemon build survives.
      remove({ dir, identity: identity(st), token: old.token })
      fs.mkdirSync(dir, { mode: 0o700 })
    }
    const named = fs.lstatSync(dir, { bigint: true })
    journalStat(named)
    const entry = { dir, identity: identity(named), token }
    const directoryFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
      const opened = fs.fstatSync(directoryFd, { bigint: true })
      journalStat(opened)
      if (identity(opened) !== entry.identity) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
      const fd = fs.openSync(`/proc/self/fd/${directoryFd}/record.json`, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, bootId, token })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.fsyncSync(directoryFd)
    } finally { fs.closeSync(directoryFd) }
    held.push(entry)
    // parent is anchored through an already validated retained descriptor.
    fs.fsyncSync(Number(parent.split('/').at(-1)))
  }
  try { acquire(`/proc/self/fd/${rootFds[0]}`, '.sandbox-image-preparation'); acquire(`/proc/self/fd/${rootFds[1]}`, 'toolsenabled-sandbox-image-preparation'); assertRootsCurrent() }
  catch (error) { try { for (const entry of held.reverse()) remove(entry) } finally { for (const fd of rootFds) fs.closeSync(fd) }; throw error }
  let finished = false
  return Object.freeze({
    markBuildStarted() { assertRootsCurrent(); buildStarted = true },
    finish({ completed = false } = {}) {
      if (finished) fail('SANDBOX_SETUP_COORDINATION_UNAVAILABLE')
      finished = true
      try {
        if (buildStarted && !completed) return { status: 'unknown', recoveryRequired: true }
        for (const entry of held.splice(0).reverse()) remove(entry)
        for (const fd of rootFds) fs.fsyncSync(fd)
        return { status: 'released' }
      } finally { for (const fd of rootFds) fs.closeSync(fd) }
    },
  })
}
module.exports = { acquireSandboxPreparation }
