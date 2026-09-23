'use strict'
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')
const MODULE = 'src/lib/audit-identity-maintenance.js'
function failure(code, reason) { return { ok: false, code, reason } }
function createAuditIdentitySettings({ stateRoot, resolveRoot = resolveCapabilityRoot, activeSessions = () => 0,
  quiesce = async () => ({ ok: true }), openArchive = async () => '', run: injectedRun } = {}) {
  const challenges = new Map()
  let busy = false
  let restartRequired = false
  async function run(operation, extra = {}) {
    if (injectedRun) return injectedRun(operation, extra)
    const payloadRoot = resolveRoot()
    if (!payloadRoot || !fs.existsSync(path.join(payloadRoot, MODULE))) return failure('AUDIT_REKEY_PAYLOAD_ABSENT', 'This copy does not include supported audit identity maintenance.')
    return new Promise(resolve => {
      const worker = new Worker(path.join(__dirname, 'audit-identity-worker.cjs'), { workerData: { payloadRoot, stateRoot, operation, ...extra } })
      let answered = false
      // A timeout never terminates a cutover midway; its persistent journal
      // must be left for the worker to finish or for explicit crash recovery.
      const done = value => { if (answered) return; answered = true; resolve(value) }
      worker.once('message', result => done(result))
      worker.once('error', () => done(failure('AUDIT_REKEY_WORKER_FAILED', 'The audit identity worker stopped. Inspect its state before retrying.')))
      worker.once('exit', code => { if (!answered) done(failure('AUDIT_REKEY_WORKER_FAILED', `The audit identity worker exited (${code}). Inspect its state before retrying.`)) })
    })
  }
  async function probe() {
    const result = await run('probe')
    restartRequired ||= result.restartRequired === true
    const count = activeSessions()
    if (count > 0) return { ...result, canRotate: false, canRepair: false, canRecover: false, activeSessions: count, restartRequired, reason: 'Close running or starting agents before changing the audit identity.' }
    if (restartRequired) return { ...result, canRotate: false, canRepair: false, canRecover: false, restartRequired, reason: 'Restart ToolsEnabled before another audit operation.' }
    return { ...result, restartRequired }
  }
  async function confirmation({ operation } = {}, owner) {
    if (!['rotate', 'repair', 'recover'].includes(operation)) return failure('AUDIT_REKEY_INPUT_INVALID', 'Choose rotation, repair, or interrupted-operation recovery.')
    if (busy || restartRequired) return failure('AUDIT_REKEY_BUSY', 'Finish the current audit identity operation and restart the app before another one.')
    const current = await probe()
    if (restartRequired) return { ...failure('AUDIT_REKEY_BUSY', 'Restart ToolsEnabled before another audit operation.'), restartRequired: true }
    if (!current[{ rotate: 'canRotate', repair: 'canRepair', recover: 'canRecover' }[operation]]) return failure(current.code || 'AUDIT_REKEY_UNAVAILABLE', current.reason || 'The audit identity cannot be changed now.')
    for (const [id, previous] of challenges) if (previous.owner === owner || previous.expiresAt < Date.now()) challenges.delete(id)
    const confirmationId = crypto.randomUUID()
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0')
    const expiresAt = Date.now() + 120000
    challenges.set(confirmationId, { owner, operation, code, expiresAt, fingerprint: current.fingerprint })
    return { ok: true, confirmationId, code, expiresAt, operation }
  }
  async function rotate({ confirmationId, code } = {}, owner) {
    const pending = challenges.get(confirmationId)
    challenges.delete(confirmationId)
    if (!pending || pending.owner !== owner || pending.code !== code || pending.expiresAt < Date.now()) return failure('AUDIT_REKEY_CONFIRMATION_REQUIRED', 'Retype the current four-digit code in this window. The audit identity was not changed.')
    if (busy || restartRequired || activeSessions() > 0) return failure('AUDIT_REKEY_BUSY', 'Close running or starting agents before changing the audit identity.')
    busy = true
    try {
      const current = await probe()
      if (restartRequired) return { ...failure('AUDIT_REKEY_BUSY', 'Restart ToolsEnabled before another audit operation.'), restartRequired: true }
      if (current.fingerprint !== pending.fingerprint) return failure('AUDIT_REKEY_STATE_CHANGED', 'Audit activity changed since confirmation. Inspect and confirm again.')
      const quiet = await quiesce()
      restartRequired = quiet?.restartRequired === true
      if (quiet?.ok !== true) return quiet || failure('AUDIT_REKEY_BUSY', 'Audit writers could not be closed.')
      if (activeSessions() > 0) return failure('AUDIT_REKEY_BUSY', 'An agent started before maintenance could take ownership. No audit identity was changed.')
      if (typeof quiet.revalidate === 'function' && quiet.revalidate() !== true) return { ...failure('AUDIT_REKEY_QUIESCE_CHANGED', 'App-owned cleanup changed. Restart before retrying audit maintenance.'), restartRequired }
      const result = await run(pending.operation, { fingerprint: pending.fingerprint, quiesced: true })
      restartRequired = quiet.restartRequired === true || result.restartRequired === true
      return { ...result, restartRequired }
    } finally { busy = false }
  }
  async function reveal({ archivePath } = {}) {
    const result = await run('reveal', { archivePath })
    if (!result.ok) return result
    const error = await openArchive(result.archivePath)
    return error ? failure('AUDIT_REKEY_ARCHIVE_OPEN_FAILED', 'The audit archive exists but could not be opened.') : { ok: true }
  }
  return Object.freeze({ probe, confirmation, rotate, reveal, isBusy: () => busy || restartRequired })
}
module.exports = { createAuditIdentitySettings, MODULE }
