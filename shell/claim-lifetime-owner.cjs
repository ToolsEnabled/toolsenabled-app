'use strict'

/* This process outlives its GUI IPC peer. Its signing key arrives only through
   that private channel and is never inherited by the claim/credential tree. */
const crypto = require('node:crypto')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { spawnOwnedClaim } = require('./owned-claim-process.cjs')
const { descriptor, signTerminal, writeTerminal } = require('./claim-lifetime-receipts.cjs')
const { relayChildEnvironment } = require('./relay-supervisor.cjs')

if (typeof process.send !== 'function') process.exit(2)
let phase = 'uninitialized'
let identity = null
let key = null
let launch = null
let owned = null
let cancelled = false
let stdoutAvailable = true
let outputBytes = 0
process.stdout.on('error', () => { stdoutAvailable = false })
process.stderr.on('error', () => {})

function send(value) {
  if (process.connected) { try { process.send(value, () => {}) } catch {} }
}
function leave(code) {
  clearTimeout(handshake)
  key = null
  launch = null
  process.exitCode = code
  if (process.connected) { try { process.disconnect() } catch {} }
}
function complete(result) {
  if (phase === 'terminal') return
  phase = 'terminal'
  if (!result?.quiescent || !identity || !key) { leave(2); return }
  try {
    const envelope = signTerminal(identity, result, key)
    writeTerminal(launch.stateRoot, identity, envelope)
    send({ type: 'TERMINAL' })
    leave(0)
  } catch {
    /* No unsigned or guessed substitute receipt. The GUI's fence stays held. */
    leave(2)
  }
}
function cancel() {
  cancelled = true
  if (owned) { try { Promise.resolve(owned.cancel()).catch(() => {}) } catch {} }
  else if (identity && key) complete({ quiescent: true, started: false, exitedNormally: false, exitCode: null })
  else leave(2)
}
const handshake = setTimeout(cancel, 15_000)
process.on('disconnect', cancel)

process.on('message', message => {
  if (!message || typeof message !== 'object' || phase === 'terminal') return
  if (message.type === 'CANCEL') { cancel(); return }
  if (message.type === 'INIT' && phase === 'uninitialized') {
    try {
      if (JSON.stringify(message).length > 128 * 1024) throw Error('Oversized initialization.')
      const id = descriptor(message.descriptor)
      const candidateKey = crypto.createPrivateKey({ key: Buffer.from(message.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
      const publicKey = crypto.createPublicKey(candidateKey).export({ format: 'der', type: 'spki' }).toString('base64')
      if (candidateKey.asymmetricKeyType !== 'ed25519' || publicKey !== id.publicKey) throw Error('Ownership key mismatch.')
      const options = message.launch
      if (!options || !path.isAbsolute(options.command || '') || !path.isAbsolute(options.payloadRoot || '')
          || !path.isAbsolute(options.stateRoot || '') || !Array.isArray(options.args)
          || options.args.some(value => typeof value !== 'string' || value.includes('\0'))) throw Error('Invalid launch.')
      if (options.input !== undefined && (typeof options.input !== 'string' || Buffer.byteLength(options.input, 'utf8') > 65536)) throw Error('Invalid private input.')
      const environment = relayChildEnvironment(options.environment, { stateRoot: options.stateRoot })
      if (typeof options.environment?.TOOLSENABLED_ACCOUNT_ORIGIN === 'string') {
        environment.TOOLSENABLED_ACCOUNT_ORIGIN = options.environment.TOOLSENABLED_ACCOUNT_ORIGIN
      }
      identity = id
      key = candidateKey
      launch = { command: options.command, args: options.args, payloadRoot: options.payloadRoot,
        stateRoot: options.stateRoot, environment, ...(options.input === undefined ? {} : { input: options.input }) }
      message.privateKey = null
      phase = 'initialized'
      send({ type: 'INITIALIZED' })
    } catch { cancel() }
    return
  }
  if (message.type === 'START' && phase === 'initialized' && !cancelled) {
    clearTimeout(handshake)
    phase = 'running'
    try {
      owned = spawnOwnedClaim({ spawn, ...launch })
    } catch {
      /* The low-level constructor only throws before target admission. */
      complete({ quiescent: true, started: false, exitedNormally: false, exitCode: null })
      return
    }
    /* Once constructed, every failure must retain and reconcile this owner;
       listener setup failure can no longer mean NOT_ATTEMPTED. */
    Promise.resolve(owned.completion).then(complete, () => complete({ quiescent: false }))
    try {
      owned.child.stdout.on('data', chunk => {
        outputBytes += chunk.length
        if (outputBytes > 128 * 1024) { cancel(); return }
        if (stdoutAvailable) {
          try { process.stdout.write(chunk) } catch { stdoutAvailable = false }
        }
      })
      owned.child.stderr.on('data', () => {})
    } catch { cancel() }
    return
  }
  cancel()
})
send({ type: 'READY' })
