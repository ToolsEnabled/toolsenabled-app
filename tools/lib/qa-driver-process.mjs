import { spawn } from 'node:child_process'
import ownedModule from '../../shell/owned-claim-process.cjs'
import { runOwnedProcess } from './owned-process.mjs'

// Linux reuses the reviewed subreaper/pidfd owner, not the device-claim API.
// The only executed command is the supplied QA driver. No vault, account or
// enrollment state is read or changed by this adapter.
export async function runQaDriverProcess(command, args, { cwd, env,
  timeoutMs, cleanupMs = 15_000, maxOutputBytes = 8 * 1024 * 1024,
  platform = process.platform, spawnOwner = ownedModule.spawnOwnedClaim,
  runRoot = runOwnedProcess,
} = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('QA driver requires an explicit child environment')
  for (const value of [timeoutMs, cleanupMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('QA process limits must be positive integers')
  }
  if (platform !== 'linux') {
    // The existing helper owns the root handle on Windows, not its whole Job.
    // A cancelled root therefore cannot authorize a retry or another driver.
    const result = await runRoot(command, args, { cwd, env, timeoutMs, cleanupMs, maxOutputBytes })
    return { ...result, timedOut: result.failureReason?.startsWith('process timed out after ') === true,
      cleanupConfirmed: result.cleanupScope === 'not-spawned',
      cleanupUnconfirmed: Boolean(result.failureReason && result.cleanupScope !== 'not-spawned') }
  }
  return new Promise(resolve => {
    let owner
    let output = ''
    let outputBytes = 0
    let ended = false
    let timedOut = false
    let failureReason = null
    let watchdog
    let cleanupTimer
    const finish = receipt => {
      if (ended) return
      ended = true
      clearTimeout(watchdog)
      clearTimeout(cleanupTimer)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      const cleanupConfirmed = receipt?.quiescent === true
      if (!cleanupConfirmed) {
        failureReason ||= 'QA owner closed without a valid empty-descendant receipt'
        // Closing the control pipe asks the native owner to keep cleaning up.
        // Do not kill the supervisor or look up any numeric PID after exit.
        owner?.child.unref?.()
        for (const stream of owner?.child.stdio || []) stream?.destroy?.()
      }
      if (!receipt?.started && !failureReason) failureReason = 'Native QA ownership unavailable before driver launch'
      if (!receipt?.exitedNormally && !failureReason) failureReason = 'QA driver did not complete normally'
      resolve({ code: failureReason ? null : receipt.exitCode, signal: null, output, outputBytes,
        failureReason, timedOut, cleanupConfirmed, cleanupUnconfirmed: !cleanupConfirmed,
        cleanupScope: cleanupConfirmed ? 'linux-subreaper-pidfd-empty' : 'linux-owner-unconfirmed' })
    }
    const stop = reason => {
      if (ended || failureReason) return
      clearTimeout(watchdog)
      failureReason = reason
      cleanupTimer = setTimeout(() => finish(null), cleanupMs)
      try { Promise.resolve(owner.cancel()).catch(() => finish(null)) }
      catch { finish(null) }
    }
    const interrupt = () => stop('QA process cancelled by SIGINT')
    const terminate = () => stop('QA process cancelled by SIGTERM')
    try {
      owner = spawnOwner({ spawn, command, args, payloadRoot: cwd, stateRoot: cwd,
        environment: env, platform, cleanupTimeoutMs: cleanupMs })
    } catch (error) {
      // Conservatively unknown: a throwing owner is not an empty-tree receipt.
      failureReason = `QA owner could not be established: ${error.code || error.name || 'ERROR'}`
      finish(null)
      return
    }
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    watchdog = setTimeout(() => { timedOut = true; stop(`QA process timed out after ${timeoutMs} ms`) }, timeoutMs)
    const collect = chunk => {
      if (ended || failureReason) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += buffer.length
      if (outputBytes > maxOutputBytes) { stop(`QA process output exceeded ${maxOutputBytes} bytes`); return }
      output += buffer.toString('utf8')
    }
    owner.child.stdout.on('data', collect)
    owner.child.stderr.on('data', collect)
    owner.completion.then(finish, () => finish(null))
  })
}

export function mayRetryQaDriver(result) {
  return result.verdict === 'TIMEOUT' && result.cleanupConfirmed === true
    && result.cleanupUnconfirmed !== true
}
