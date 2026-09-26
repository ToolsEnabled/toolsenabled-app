'use strict'

const path = require('node:path')
const { createIdentity, reconcileOwnership } = require('./claim-lifetime-receipts.cjs')

function spawnClaimLifetime({ spawn, command, args, payloadRoot, stateRoot, environment, input,
  onOwnershipStart = () => false, onOwnershipComplete = () => {},
} = {}) {
  if (typeof spawn !== 'function' || !path.isAbsolute(command || '') || !path.isAbsolute(payloadRoot || '')
      || !path.isAbsolute(stateRoot || '')) throw Error('Explicit owned launch inputs required.')
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 65536)) throw Error('Invalid private claim input.')
  const identity = createIdentity()
  let privateKey = identity.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  identity.privateKey = null
  const expected = identity.descriptor
  const child = spawn(command, [path.join(__dirname, 'claim-lifetime-owner.cjs')], {
    cwd: payloadRoot, env: environment, windowsHide: true, detached: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let initialized = false
  let initializationSent = false
  let startSent = false
  let hookStarted = false
  let cancelled = false
  let closed = false
  const send = value => {
    if (closed || !child.connected) return false
    try { child.send(value, () => {}); return true } catch { return false }
  }
  const cancel = () => { cancelled = true; if (initialized) send({ type: 'CANCEL' }); return completion }
  child.on('error', () => {})
  child.on('message', async value => {
    if (!value || typeof value !== 'object' || closed) return
    if (value.type === 'READY' && !initializationSent) {
      initializationSent = true
      send({ type: 'INIT', descriptor: expected, privateKey,
        launch: { command, args, payloadRoot, stateRoot, environment, ...(input === undefined ? {} : { input }) } })
      privateKey = null
      return
    }
    if (value.type === 'INITIALIZED' && initializationSent && !initialized) {
      initialized = true
      if (cancelled) { cancel(); return }
      hookStarted = true
      let admitted = false
      try { admitted = await onOwnershipStart(expected) === true } catch {}
      if (closed) return
      if (!admitted || cancelled) { cancel(); return }
      /* Record intent before the IPC write: a lost START acknowledgment is
         uncertain, never a fabricated pre-spawn refusal. */
      startSent = true
      if (!send({ type: 'START' })) cancel()
      return
    }
    if (value.type !== 'TERMINAL') cancel()
  })
  const completion = new Promise(resolve => {
    child.once('close', async () => {
      closed = true
      privateKey = null
      const verified = reconcileOwnership(stateRoot, expected)
      if (verified.quiescent) {
        try { await onOwnershipComplete(expected, verified.receipt) } catch {}
        resolve(Object.freeze({ quiescent: true, started: verified.receipt.started,
          exitedNormally: verified.receipt.exitedNormally, exitCode: verified.receipt.exitCode }))
      } else if (!hookStarted && !startSent) {
        /* The GUI never reached the durable admission hook or sent START.
           Actual retained proxy close proves no target was admitted. */
        resolve(Object.freeze({ quiescent: true, started: false, exitedNormally: false, exitCode: null }))
      } else resolve(Object.freeze({ quiescent: false, started: startSent,
        exitedNormally: false, exitCode: null }))
    })
  })
  return Object.freeze({ child, completion, cancel, descriptor: expected })
}

module.exports = { spawnClaimLifetime }
