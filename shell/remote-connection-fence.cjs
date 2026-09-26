'use strict'

// Remote authority is fenced before disconnect yields. This small owner-only
// record survives an ordinary app restart even when clearing the credential
// fails. It contains no account, device, credential or consent value.
const nodeFs = require('node:fs')
const nodePath = require('node:path')
const { randomUUID: makeId, createPublicKey } = require('node:crypto')

const FILE_NAME = 'remote-connection-state.json'
const MAX_RECORD_BYTES = 2048
const OUTCOMES = new Set(['NOT_ATTEMPTED', 'REMOVED_SYNCED', 'UNCERTAIN'])

function ownershipDescriptor(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3 || value.version !== 1
      || typeof value.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
      || typeof value.publicKey !== 'string' || value.publicKey.length !== 60) return null
    const bytes = Buffer.from(value.publicKey, 'base64')
    if (bytes.length !== 44 || bytes.toString('base64') !== value.publicKey) return null
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519'
      || key.export({ format: 'der', type: 'spki' }).toString('base64') !== value.publicKey) return null
    return Object.freeze({ version: 1, id: value.id, publicKey: value.publicKey })
  } catch { return null }
}
function administrativeOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !/^[0-9a-f]{48}$/.test(value.operationId || '') || !/^[0-9a-f]{64}$/.test(value.contextDigest || '')) return null
  return Object.freeze({ operationId: value.operationId, contextDigest: value.contextDigest })
}
function sameAdministration(first, second) {
  return first && second && first.operationId === second.operationId && first.contextDigest === second.contextDigest
}
function sameOwner(first, second) {
  return first && second && first.id === second.id && first.publicKey === second.publicKey
}

function createRemoteConnectionFence({
  directory,
  fs = nodeFs,
  path = nodePath,
  randomUUID = makeId,
  platform = process.platform,
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('Remote connection state requires an absolute directory')
  }
  const file = path.join(directory, FILE_NAME)
  let blocked = true
  let recorded = false
  let damaged = false
  let legacy = false
  let generation = 0
  let adminOperation = null
  let pendingOwner = null
  let disconnectPending = false
  let mutationOutcome = null
  let used = false

  function readRecord() {
    blocked = true
    recorded = false
    damaged = false
    legacy = false
    adminOperation = null
    pendingOwner = null
    disconnectPending = false
    mutationOutcome = null
    // A malformed or unreadable record is a refusal, never a default consent.
    // lstat plus no-follow where available rejects a record redirected elsewhere.
    let descriptor
    let sawRecord = false
    try {
      const stat = fs.lstatSync(file)
      sawRecord = true
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) {
        throw new Error('invalid record')
      }
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.size > MAX_RECORD_BYTES
        || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('invalid record')
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
      if (bytes > MAX_RECORD_BYTES) throw new Error('invalid record')
      const value = JSON.parse(buffer.subarray(0, bytes).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !([2, 3].includes(value.version))
        || Object.keys(value).length !== (value.version === 3 ? 6 : 5)
        || !['blocked', 'active'].includes(value.state)
        || typeof value.disconnectPending !== 'boolean'
        || (value.mutationOutcome !== null && !OUTCOMES.has(value.mutationOutcome))) throw new Error('invalid record')
      adminOperation = value.version === 3 ? administrativeOperation(value.adminOperation) : null
      if (value.version === 3 && (!adminOperation || value.state !== 'blocked')) throw new Error('invalid administration')
      pendingOwner = value.pendingOwner === null ? null : ownershipDescriptor(value.pendingOwner)
      if (value.pendingOwner !== null && !pendingOwner) throw new Error('invalid owner')
      if (value.state === 'active' && value.disconnectPending) throw new Error('invalid state')
      blocked = value.state === 'blocked'
      disconnectPending = value.disconnectPending
      mutationOutcome = value.mutationOutcome
      // A child from a previous GUI instance may still be changing credentials.
      // Even an active record cannot admit remote work until its exact signed
      // terminal receipt has been reconciled. A new status child's clean exit
      // is unrelated evidence and cannot release this fence.
      if (pendingOwner) { blocked = true; disconnectPending = true }
      recorded = true
    } catch (error) {
      if (!sawRecord && error && error.code === 'ENOENT') {
        // An installation predating this record retains its existing enrollment
        // checks. Absence after a *known* failed write never clears this instance.
        blocked = false
        legacy = true
      } else {
        damaged = true
      }
    } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch {} }
    }
  }
  readRecord()

  function snapshot() {
    return Object.freeze({
      blocked,
      generation,
      restartSafety: recorded ? 'recorded' : (legacy ? 'legacy' : 'unknown'),
      damaged,
      pendingOwner,
      adminOperation,
      disconnectPending,
      mutationOutcome,
    })
  }

  // A rare, bounded local decision is written synchronously so another owner
  // disconnect cannot interleave an older reconnect's final rename. File flush
  // and (on POSIX) directory flush are observed; this is not a power-loss claim.
  function persist(state) {
    used = true
    let handle
    let published = false
    legacy = false
    const temporary = path.join(directory, '.remote-connection-' + randomUUID() + '.tmp')
    try {
      // userData is provisioned by the application. Do not create ancestors or
      // repair an unreadable customer record as a side effect of a disconnect.
      if (damaged) return { published: false, synced: false }
      handle = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(handle, JSON.stringify({ version: adminOperation ? 3 : 2, state, pendingOwner,
        disconnectPending, mutationOutcome, ...(adminOperation ? { adminOperation } : {}) }) + '\n', 'utf8')
      fs.fsyncSync(handle)
      fs.closeSync(handle)
      handle = undefined
      fs.renameSync(temporary, file)
      published = true
      if (platform !== 'win32') {
        const parent = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
        try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
      }
      recorded = true
      return { published: true, synced: true }
    } catch {
      recorded = false
      return { published, synced: false }
    } finally {
      if (handle !== undefined) { try { fs.closeSync(handle) } catch {} }
      try { fs.unlinkSync(temporary) } catch {}
    }
  }

  return Object.freeze({
    snapshot,
    // Construction precedes Electron's single-instance lock. Refresh only
    // after becoming the primary, before any operation can admit a child.
    // Otherwise a second launch can overwrite a descriptor the prior GUI
    // wrote between this module's initial read and its eventual crash.
    refreshForPrimary() {
      if (used || generation !== 0) return false
      readRecord()
      return true
    },
    ticket: () => generation,
    isCurrent: ticket => Number.isSafeInteger(ticket) && ticket === generation,
    allowsRemote: () => !blocked,
    // The proxy has not been permitted to START when this hook runs. Every
    // invocation is persisted, including ordinary reads while still connected.
    // Never replace an older unresolved owner with a newer helper's identity.
    admitOwnership(value) {
      const owner = ownershipDescriptor(value)
      if (!owner || damaged || (pendingOwner && !sameOwner(pendingOwner, owner))) return false
      pendingOwner = owner
      const outcome = persist(blocked ? 'blocked' : 'active')
      if (!outcome.synced) { blocked = true; disconnectPending = true }
      return outcome.synced
    },
    // Only main's owned-claim verifier calls this with an authenticated,
    // descriptor-bound terminal payload. No IPC surface accepts these fields.
    completeOwnership(value, receipt) {
      const owner = ownershipDescriptor(value)
      if (!owner || !sameOwner(pendingOwner, owner) || receipt?.version !== 1
        || receipt.kind !== 'claim-lifetime-terminal' || receipt.id !== owner.id
        || receipt.quiescent !== true) return false
      const previous = pendingOwner
      pendingOwner = null
      const outcome = persist(blocked ? 'blocked' : 'active')
      if (!outcome.published) pendingOwner = previous
      return outcome.published
    },
    // Call first, before closing windows, signalling children or awaiting I/O.
    block() {
      used = true
      generation += 1
      adminOperation = null
      blocked = true
      recorded = false
      legacy = false
      disconnectPending = true
      return generation
    },
    recordDisconnect(ticket) {
      if (ticket !== generation || !blocked) return false
      return persist('blocked').synced
    },
    recordOutcome(ticket, outcome) {
      if (ticket !== generation || !blocked || !OUTCOMES.has(outcome)) return false
      mutationOutcome = outcome
      return persist('blocked').synced
    },
    completeCleanup(ticket) {
      if (ticket !== generation || !blocked || damaged || pendingOwner) return false
      disconnectPending = false
      const outcome = persist('blocked')
      if (!outcome.published) disconnectPending = true
      return outcome.synced
    },
    // Administrative ownership is a separate durable operation, never a made-up
    // browser claim. A restart retains its binding while remote access is OFF.
    reserveAdministration(ticket, value) {
      const operation = administrativeOperation(value)
      if (ticket !== generation || !operation || damaged || pendingOwner || disconnectPending || adminOperation) return null
      generation += 1
      blocked = true
      adminOperation = operation
      return persist('blocked').synced ? generation : null
    },
    cancelAdministration(ticket, value) {
      if (ticket !== generation || damaged || pendingOwner || disconnectPending || !sameAdministration(adminOperation, value)) return false
      const previous = adminOperation
      adminOperation = null
      const outcome = persist('blocked')
      if (!outcome.published) adminOperation = previous
      return outcome.synced
    },
    completeAdministrativeEnrollment(ticket, value, { consentCleared = false } = {}) {
      if (ticket !== generation || consentCleared !== true || damaged || pendingOwner || disconnectPending
          || !sameAdministration(adminOperation, value)) return false
      const previous = adminOperation
      adminOperation = null
      const outcome = persist('active')
      if (!outcome.synced) {
        // Administrative completion promises a durable fence transition. If a
        // replacement was visible but its directory flush failed, restore the
        // blocked operation and report refusal. Failed restoration remains an
        // explicit unknown persistence outcome, never successful enrollment.
        adminOperation = previous
        blocked = true
        if (outcome.published) persist('blocked')
        return false
      }
      blocked = false
      return true
    },
    // A status read is deliberately not an unblocking API. Only the main
    // process's successful new claim, tied to its initiating ticket and a
    // saved OFF preference, may reach this method.
    completeFreshClaim(ticket, { consentCleared = false } = {}) {
      if (ticket !== generation || consentCleared !== true || damaged
        || adminOperation || pendingOwner || disconnectPending) return false
      blocked = true
      const outcome = persist('active')
      if (!outcome.published) return false
      // The explicit new claim already authorizes this connection. A rename
      // that succeeded followed by failed directory sync is active now, with
      // unknown restart persistence, not a fictitious rolled-back grant.
      blocked = false
      return true
    },
  })
}

module.exports = { FILE_NAME, MAX_RECORD_BYTES, ownershipDescriptor, createRemoteConnectionFence }
