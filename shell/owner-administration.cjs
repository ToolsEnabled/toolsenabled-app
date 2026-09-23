'use strict'

// This opt-in channel has no path, account, key, credential or consent argument.
// An owner provisions the protected files locally through a separate trusted
// administrative channel; ordinary installs have no config and always refuse.
const fs = require('node:fs')
const path = require('node:path')
const contract = require('./owner-administration-contract.cjs')
const DIRECTORY = 'owner-administration'
const CONFIG_FILE = 'config.json'
const REPLY_FILE = 'reply.json'
function refusal() {
  return Object.freeze({ ok: false, code: 'DEVICE_ADMIN_CONFIGURATION_REFUSED',
    reason: 'Administrative enrollment requires a valid protected local operation configuration.' })
}
function readInputs(directory, stateRoot, action, uid = process.getuid()) {
  let directoryFd
  const privateStat = (stat, isDirectory) => stat.uid === uid && !(stat.mode & 0o077)
    && (isDirectory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
  try {
    const named = fs.lstatSync(directory)
    if (!privateStat(named, true) || named.isSymbolicLink()) throw Error('Invalid private directory')
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const opened = fs.fstatSync(directoryFd)
    if (!privateStat(opened, true) || opened.dev !== named.dev || opened.ino !== named.ino) throw Error('Directory changed')
    function read(name, maximum) {
      let fd
      try {
        // Linux dirfd anchor keeps both reads in the same checked directory.
        fd = fs.openSync('/proc/self/fd/' + directoryFd + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        const before = fs.fstatSync(fd)
        if (!privateStat(before, false) || before.size > maximum) throw Error('Invalid private input')
        const bytes = Buffer.alloc(maximum + 1)
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
        const after = fs.fstatSync(fd)
        if (length > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs
          || before.ctimeMs !== after.ctimeMs || length !== after.size) throw Error('Private input changed')
        return JSON.parse(bytes.subarray(0, length).toString('utf8'))
      } finally { if (fd !== undefined) fs.closeSync(fd) }
    }
    const config = read(CONFIG_FILE, 16384)
    if (!contract.exact(config, ['version', ...contract.CONTEXT_KEYS]) || config.version !== 1) throw Error('Invalid config')
    const context = contract.context(Object.fromEntries(contract.CONTEXT_KEYS.map(name => [name, config[name]])), stateRoot, action === 'identity')
    const result = { context }
    if (['import', 'finalize'].includes(action)) {
      const inbox = read(REPLY_FILE, 49152)
      if (!contract.exact(inbox, ['version', 'action', 'operationId', 'reply']) || inbox.version !== 1
        || inbox.action !== action || inbox.operationId !== context.operationId || !inbox.reply
        || typeof inbox.reply !== 'object' || Array.isArray(inbox.reply)) throw Error('Invalid inbox')
      result.reply = inbox.reply
    }
    return result
  } finally { if (directoryFd !== undefined) fs.closeSync(directoryFd) }
}
function createOwnerAdministration({ userData, stateRoot, lifecycle, webDriveEnabled,
  available = () => true, platform = process.platform } = {}) {
  if (!path.isAbsolute(userData || '') || !path.isAbsolute(stateRoot || '') || typeof lifecycle?.administer !== 'function'
    || typeof webDriveEnabled !== 'function' || typeof available !== 'function') throw TypeError('Explicit native administration dependencies required')
  return Object.freeze({
    async run(action) {
      if (platform !== 'linux' || typeof action !== 'string' || !contract.ACTIONS.has(action) || available() !== true) return refusal()
      let input
      try { input = readInputs(path.join(userData, DIRECTORY), stateRoot, action) } catch { return refusal() }
      if (action === 'pair-request') {
        try { input.webDriveEnabled = webDriveEnabled() === true } catch { return refusal() }
        if (!input.webDriveEnabled) return refusal()
        input.consentStillEnabled = () => available() === true && webDriveEnabled() === true
      }
      // No input file content is returned by this controller. The claim module
      // independently copies only signed public requests and bounded receipts.
      return lifecycle.administer(action, input)
    },
  })
}
module.exports = { DIRECTORY, CONFIG_FILE, REPLY_FILE, readInputs, createOwnerAdministration }
