'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LIMIT = 4096

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function decode(value, size) {
  if (typeof value !== 'string' || value.length > 128) throw Error('Invalid ownership key.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== size || bytes.toString('base64') !== value) throw Error('Invalid ownership key.')
  return bytes
}
function descriptor(value) {
  if (!exactKeys(value, ['version', 'id', 'publicKey']) || value.version !== 1 || !UUID.test(value.id)) {
    throw Error('Invalid ownership descriptor.')
  }
  const key = crypto.createPublicKey({ key: decode(value.publicKey, 44), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Invalid ownership key.')
  return Object.freeze({ version: 1, id: value.id, publicKey: value.publicKey })
}
function createIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { descriptor: descriptor({ version: 1, id: crypto.randomUUID(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }), privateKey }
}
function terminal(value, expected) {
  const keys = ['version', 'kind', 'id', 'quiescent', 'started', 'exitedNormally', 'exitCode']
  if (!exactKeys(value, keys) || value.version !== 1 || value.kind !== 'claim-lifetime-terminal'
      || value.id !== expected.id || value.quiescent !== true || typeof value.started !== 'boolean'
      || typeof value.exitedNormally !== 'boolean'
      || !(value.exitCode === null || Number.isSafeInteger(value.exitCode))
      || (!value.started && (value.exitedNormally || value.exitCode !== null))) {
    throw Error('Invalid ownership terminal receipt.')
  }
  return Object.freeze({ version: 1, kind: 'claim-lifetime-terminal', id: expected.id,
    quiescent: true, started: value.started, exitedNormally: value.exitedNormally, exitCode: value.exitCode })
}
function signTerminal(expected, result, privateKey) {
  const id = descriptor(expected)
  const payload = terminal({ version: 1, kind: 'claim-lifetime-terminal', id: id.id,
    quiescent: result.quiescent, started: result.started, exitedNormally: result.exitedNormally,
    exitCode: result.exitCode }, id)
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
  return Object.freeze({ payload, signature })
}
function verifyTerminal(expected, envelope) {
  const id = descriptor(expected)
  if (!exactKeys(envelope, ['payload', 'signature'])) throw Error('Invalid ownership envelope.')
  const payload = terminal(envelope.payload, id)
  const key = crypto.createPublicKey({ key: decode(id.publicKey, 44), format: 'der', type: 'spki' })
  if (!crypto.verify(null, Buffer.from(JSON.stringify(payload)), key, decode(envelope.signature, 64))) {
    throw Error('Ownership receipt authentication failed.')
  }
  return payload
}

function ownedStat(file, directory, privateMode = true) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error('Unsafe ownership receipt path.')
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (privateMode && (stat.mode & 0o077) !== 0))) {
    throw Error('Ownership receipt path must be private to its owner.')
  }
  return stat
}
function receiptPath(stateRoot, expected, create = false) {
  const id = descriptor(expected)
  if (!path.isAbsolute(stateRoot || '')) throw Error('An explicit ownership state root is required.')
  /* State root is app-owned. Do not follow a new link beneath it, and do not
     repair someone else's ACL or modes to make a receipt operation succeed. */
  ownedStat(stateRoot, true, false)
  let directory = stateRoot
  for (const name of ['state', 'claim-lifetimes']) {
    directory = path.join(directory, name)
    if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error } }
    ownedStat(directory, true, name === 'claim-lifetimes')
  }
  return path.join(directory, id.id + '.json')
}
function writeTerminal(stateRoot, expected, envelope) {
  verifyTerminal(expected, envelope)
  const target = receiptPath(stateRoot, expected, true)
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n')
  if (bytes.length > LIMIT) throw Error('Ownership receipt is oversized.')
  const temporary = target + '.' + crypto.randomUUID() + '.tmp'
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    /* Unique invocation IDs are never reused. Refuse to replace an existing
       terminal receipt, including one another process has tampered with. */
    fs.linkSync(temporary, target)
    fs.unlinkSync(temporary)
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
function reconcileOwnership(stateRoot, expected) {
  try {
    const file = receiptPath(stateRoot, expected)
    const stat = ownedStat(file, false)
    if (stat.size > LIMIT) throw Error('Ownership receipt is oversized.')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    let envelope
    try {
      const opened = fs.fstatSync(fd)
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > LIMIT) throw Error('Ownership receipt changed while opening.')
      const bytes = Buffer.alloc(LIMIT + 1)
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
      if (count > LIMIT) throw Error('Ownership receipt is oversized.')
      envelope = JSON.parse(bytes.subarray(0, count).toString('utf8'))
    } finally { fs.closeSync(fd) }
    return Object.freeze({ quiescent: true, receipt: verifyTerminal(expected, envelope) })
  } catch {
    return Object.freeze({ quiescent: false })
  }
}

module.exports = { LIMIT, createIdentity, descriptor, signTerminal, verifyTerminal, writeTerminal, reconcileOwnership }
