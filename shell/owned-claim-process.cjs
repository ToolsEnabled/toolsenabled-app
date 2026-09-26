'use strict'

const fs = require('node:fs')
const path = require('node:path')

const CLEANUP_TIMEOUT_MS = 5_000
const LINUX_HELPER = path.join(__dirname, 'owned-claim-process-linux.py')

/* A claim may mutate the vault in a grandchild. A ChildProcess exit/close is
   therefore not the end of this invocation. The completion below belongs to
   the containment owner, and only a proved empty owner releases the lane.
   Neither platform writes the CLI arguments, environment or output to disk. */
function spawnOwnedClaim({ spawn, command, args, payloadRoot, stateRoot, environment, input,
  platform = process.platform, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  loadJobControl = (file) => require(file), readHelper = () => fs.readFileSync(LINUX_HELPER, 'utf8'),
} = {}) {
  if (typeof spawn !== 'function' || !path.isAbsolute(payloadRoot || '')
      || !path.isAbsolute(stateRoot || '') || !path.isAbsolute(command || '')) {
    throw new TypeError('An owned claim requires explicit absolute launch roots.')
  }
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 65536
      || platform !== 'linux')) throw new TypeError('Private claim input requires bounded Linux containment.')
  if (platform === 'win32') {
    const { spawnInJob } = loadJobControl(path.join(payloadRoot, 'src', 'lib', 'windows-job-control.js'))
    const child = spawnInJob(command, args, {
      cwd: payloadRoot, env: environment, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true,
    }, {
      platform, spawnImpl: spawn,
      /* environment was built by the one canonical relay/claim allowlist. */
      safeLaunchEnvironment: () => ({ ...environment }),
      wrapperScript: path.join(payloadRoot, 'tools', 'windows-job-wrapper.ps1'),
      recordDirectory: path.join(stateRoot, 'state', 'claim-jobs'),
      assemblyCacheDirectory: path.join(stateRoot, 'state', 'windows-job-wrapper-cache'),
      cleanupTimeoutMs,
    })
    child.on('error', () => {})
    const completion = Promise.allSettled([child.jobOutcome, child.jobClosed]).then(([outcome, closed]) => {
      const value = outcome.status === 'fulfilled' ? outcome.value : null
      const closure = closed.status === 'fulfilled' ? closed.value : null
      const quiescent = !!(value && value.activeProcesses === 0
        && ['exit', 'terminated', 'not-started'].includes(value.type) && closure && !closure.failure)
      return Object.freeze({ quiescent, started: value?.type !== 'not-started',
        exitedNormally: quiescent && value.type === 'exit' && closure.signal == null
          && closure.code === value.exitCode,
        exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null })
    })
    let cancellation
    function cancel() {
      if (!cancellation) {
        const fallback = setTimeout(() => {
          /* Exact retained wrapper handle; its Job's kill-on-close is the last
             cleanup attempt. It does not manufacture a successful receipt. */
          child.terminateRetainedWrapper().catch(() => {})
        }, cleanupTimeoutMs)
        fallback.unref?.()
        child.terminateJob().catch(() => {})
        cancellation = completion.finally(() => clearTimeout(fallback))
      }
      return cancellation
    }
    return Object.freeze({ child, completion, cancel })
  }
  if (platform !== 'linux') throw new Error('Owned device claims are unavailable on this platform.')

  /* fs can read this static source from app.asar. Python cannot execute an
     asar path, so use -c; no extracted script or secret-bearing spec file. */
  const source = readHelper()
  const child = spawn('/usr/bin/python3', ['-I', '-u', '-c', source, ...(input === undefined ? [] : ['--private-stdin']), command, ...args], {
    cwd: payloadRoot, env: environment, windowsHide: true, shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', ...(input === undefined ? [] : ['pipe'])],
  })
  let started = false
  let cancelled = false
  let protocolValid = true
  let ready = false
  let receipt = null
  let buffer = ''
  let receivedBytes = 0
  let spawned = false
  let spawnError = false
  const send = (value) => {
    try { child.stdin.write(value + '\n') } catch { protocolValid = false }
  }
  child.stdin.on('error', () => {})
  child.on('spawn', () => { spawned = true })
  child.on('error', () => { spawnError = true })
  if (input !== undefined) {
    const stream = child.stdio?.[4]
    if (!stream) { protocolValid = false }
    else {
      stream.on('error', () => { protocolValid = false; send('CANCEL') })
      // The CLI receives only this pipe, never the supervisor's control pipe.
      try { stream.end(input) } catch { protocolValid = false; send('CANCEL') }
    }
  }
  const channel = child.stdio && child.stdio[3]
  if (!channel) throw new Error('The owned claim receipt channel is unavailable.')
  channel.on('error', () => { protocolValid = false })
  channel.on('data', (chunk) => {
    receivedBytes += chunk.length
    if (receivedBytes > 4096) { protocolValid = false; send('CANCEL'); return }
    buffer += chunk.toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let value
      try { value = JSON.parse(line) } catch { protocolValid = false; send('CANCEL'); continue }
      if (value?.type === 'ready' && !ready && !receipt) {
        ready = true
        send(cancelled || !protocolValid ? 'CANCEL' : 'START')
      } else if (value?.type === 'started' && ready && !started && !receipt) {
        started = true
      } else if (value?.type === 'complete' && !receipt && value.quiescent === true
          && typeof value.started === 'boolean' && typeof value.cancelled === 'boolean'
          && (value.exitCode === null || Number.isInteger(value.exitCode))
          && value.started === started) {
        receipt = value
      } else {
        protocolValid = false
        send('CANCEL')
      }
    }
  })
  const completion = new Promise(resolve => {
    child.once('close', (code, signal) => {
      const neverSpawned = spawnError && !spawned && !started
      const quiescent = neverSpawned || !!(protocolValid && !buffer.trim() && receipt
        && code === 0 && signal == null)
      resolve(Object.freeze({ quiescent, started: neverSpawned ? false : receipt?.started ?? true,
        exitedNormally: !!(quiescent && receipt?.started && !receipt.cancelled && !cancelled),
        exitCode: receipt?.exitCode ?? null,
        // Old runtime receipts retain their existing shape. New qualification
        // requires an affirmative boolean, never an absent/invalid false.
        ...(quiescent && typeof receipt?.hadRemainingChildren === 'boolean'
          ? { hadRemainingChildren: receipt.hadRemainingChildren } : {}) }))
    })
  })
  function cancel() { cancelled = true; send('CANCEL'); return completion }
  return Object.freeze({ child, completion, cancel })
}

module.exports = { CLEANUP_TIMEOUT_MS, spawnOwnedClaim }
