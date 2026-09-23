import { spawn } from 'node:child_process'

/** Bounded owned process, shared by LIVE builds and release gates. Cancellation
 * never selects a PID/name after the process could have exited. Without native
 * creation-identity + retained-handle tree proof, stop only the ChildProcess
 * handle and explicitly report descendant cleanup UNCONFIRMED.
 */
export function runOwnedProcess(command, args, { cwd, env = process.env,
  timeoutMs = 15 * 60_000, maxOutputBytes = 8 * 1024 * 1024,
  cleanupMs = 15_000, log = () => {}, spawnProcess = spawn,
} = {}) {
  for (const value of [timeoutMs, maxOutputBytes, cleanupMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('owned process limits must be positive integers')
  return new Promise(resolve => {
    const child = spawnProcess(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let outputBytes = 0
    let failureReason = null
    let closed = false
    let ended = false
    let spawned = Boolean(child.pid)
    let code = null
    let signal = null
    let cleanupTimer
    const finish = terminationConfirmed => {
      if (ended) return
      ended = true
      clearTimeout(watchdog)
      clearTimeout(cleanupTimer)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      if (!closed) { child.unref(); child.stdout.destroy(); child.stderr.destroy() }
      resolve({ code: failureReason ? null : code, signal, output, outputBytes, failureReason,
        terminationConfirmed, cleanupScope: failureReason ? (spawned ? 'root-handle-only; descendants unconfirmed' : 'not-spawned') : 'natural-close' })
    }
    const stop = reason => {
      if (ended || failureReason) return
      failureReason = `${reason}; descendant cleanup UNCONFIRMED`
      log(`[owned process] ${failureReason}`)
      // On Windows Node retains the native process handle for this child. Do
      // not replace this with taskkill or another lookup of child.pid. 'close'
      // can be delayed by pipes after the root's creation identity is gone.
      if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch {} }
      cleanupTimer = setTimeout(() => finish(false), cleanupMs)
    }
    const interrupt = () => stop('process cancelled by SIGINT')
    const terminate = () => stop('process cancelled by SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const watchdog = setTimeout(() => stop(`process timed out after ${timeoutMs} ms`), timeoutMs)
    const collect = chunk => {
      if (failureReason || ended) return
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) { stop(`process output exceeded ${maxOutputBytes} bytes`); return }
      const value = chunk.toString()
      output += value
      log(value.replace(/\r?\n$/, ''))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', error => {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SPAWN_ERROR'
      failureReason = `process could not start: ${code}`
      log(`[owned process] ${error.message}`)
      spawned = Boolean(child.pid)
    })
    child.once('close', (exitCode, exitSignal) => {
      closed = true
      code = exitCode
      signal = exitSignal
      finish(!failureReason || !spawned)
    })
  })
}
