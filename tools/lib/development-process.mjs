import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { ordinaryPath } from './development-session.mjs'

const require = createRequire(import.meta.url)

// Development execution reuses the selected engine's native lifetime owner.
// This receipt proves process cleanup only, never release qualification.
export async function runDevelopmentProcess(session, command, args, { cwd = session.paths.app,
  env, timeoutMs = 6 * 60 * 60_000, signal, log = () => {}, maxOutputBytes = 128 * 1024 * 1024 } = {}) {
  if (!['linux', 'win32'].includes(process.platform)) throw Error('No native session process owner for this platform')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('A finite session process deadline is required')
  ordinaryPath(command, { directory: false })
  ordinaryPath(cwd)
  signal?.throwIfAborted()
  const { safeLaunchEnvironment } = require(path.join(session.paths.controlEngine, 'src/lib/providers/subscription-launch-env.js'))
  const dependencies = { safeLaunchEnvironment }
  const options = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true }
  let child
  const output = path.join(session.paths.evidence, 'process-' + randomUUID() + '.log')
  const fd = fs.openSync(output, 'wx', 0o600)
  let timer, cleanupTimer, expire, failure = null, cancelled = false, bytes = 0
  const stop = reason => {
    if (cancelled) return
    cancelled = true
    failure ||= reason
    child?.terminateJob().catch(error => { failure ||= error.message })
    cleanupTimer = setTimeout(() => expire?.(null), 45_000)
  }
  const interrupt = () => stop('Session operation cancelled')
  try {
    if (process.platform === 'linux') {
      const { spawnLinuxOwned } = require(path.join(session.paths.controlEngine, 'src/lib/linux-process-control.js'))
      child = spawnLinuxOwned(command, args, options, dependencies)
    } else {
      const { spawnInJob } = require(path.join(session.paths.controlEngine, 'src/lib/windows-job-control.js'))
      child = spawnInJob(command, args, options, { ...dependencies,
        recordDirectory: path.join(session.paths.evidence, 'jobs'),
        assemblyCacheDirectory: path.join(session.paths.cache, 'job-wrapper'), cleanupTimeoutMs: 30_000 })
    }
    child.on('error', error => { failure ||= error.message })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) { stop('Session output exceeded its bound'); return }
      try { fs.writeSync(fd, chunk); log(chunk.toString()) } catch (error) { stop(error.message) }
    })
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
    signal?.addEventListener('abort', interrupt, { once: true })
    if (signal?.aborted) interrupt()
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => stop('Session operation timed out'), timeoutMs)
      expire = resolve
    })
    const terminal = Promise.allSettled([child.jobOutcome, child.jobClosed])
    const result = await Promise.race([terminal, deadline])
    clearTimeout(timer); clearTimeout(cleanupTimer); expire(null)
    if (!result) {
      child.unref()
      child.stdout.destroy(); child.stderr.destroy()
      return { code: null, cleanupConfirmed: false, failure: failure || 'Native cleanup deadline expired', output, bytes }
    }
    const outcome = result[0].status === 'fulfilled' ? result[0].value : null
    const closed = result[1].status === 'fulfilled' ? result[1].value : null
    const cleanupConfirmed = outcome?.activeProcesses === 0 && closed !== null && !closed.failure
      && ['exit', 'terminated', 'not-started'].includes(outcome.type)
    return { code: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null, cleanupConfirmed,
      failure, output, bytes, outcome, wrapperClosed: closed !== null }
  } catch (error) {
    if (child) stop(error.message)
    error.cleanupConfirmed = !child
    throw error
  } finally {
    clearTimeout(timer); clearTimeout(cleanupTimer)
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
    signal?.removeEventListener('abort', interrupt)
    fs.closeSync(fd)
  }
}
