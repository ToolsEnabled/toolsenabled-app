'use strict'

// One reservation, one provider root. This object never crosses renderer IPC
// or enters a provider environment. It retains the actual engine child/job,
// including when engine startup throws before returning its session handle.
function createSessionResourceLease({ governor, token, sessionId, assertAuthority, platform = process.platform, cleanupWaitMs = 10000, requireContainment = false }) {
  let child = null
  let checked = false
  let ended = false
  let closed = false
  let zeroProcesses = false
  let releaseRequested = false
  let released = false
  let resolveCleanup
  let rejectCleanup
  const cleanup = new Promise((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject })
  cleanup.catch(() => {})
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
  const releaseIfProven = () => {
    if (!releaseRequested || released || child && (!closed || !zeroProcesses)) return
    released = true
    governor.release(token, sessionId)
    resolveCleanup()
  }
  const rootLaunch = Object.freeze({
    beforeRootSpawn() {
      if (checked || releaseRequested || ended) fail('AGENT_SESSION_START_CANCELLED', 'This session no longer has an unused provider-root start.')
      assertAuthority()
      const verdict = governor.revalidate(token)
      if (verdict?.ok !== true || typeof verdict?.then === 'function') {
        if (typeof verdict?.then === 'function') void Promise.resolve(verdict).catch(() => {})
        fail(verdict?.code || 'AGENT_RESOURCE_UNKNOWN', verdict?.reason || 'Current resource admission could not be verified.')
      }
      checked = true
    },
    spawned(retained) {
      if (child) fail('AGENT_ENGINE_INVALID_SESSION', 'A session cannot retain a second provider root.')
      child = retained
      if (!child || typeof child.once !== 'function') fail('AGENT_ENGINE_INVALID_SESSION', 'The engine did not retain its actual provider process.')
      child.once('exit', () => { ended = true })
      child.once('close', () => { ended = true; closed = true; releaseIfProven() })
      if (child.jobOutcome && typeof child.jobOutcome.then === 'function') {
        Promise.resolve(child.jobOutcome).then(outcome => {
          zeroProcesses = outcome?.activeProcesses === 0
          releaseIfProven()
          if (!zeroProcesses) rejectCleanup(Object.assign(new Error('The retained job did not prove zero processes.'), { code: 'AGENT_SESSION_CLEANUP_FAILED' }))
        }, () => { rejectCleanup(Object.assign(new Error('The retained job cleanup could not be verified.'), { code: 'AGENT_SESSION_CLEANUP_FAILED' })) })
      } else if (platform !== 'win32' && !requireContainment) {
        // On the direct-spawn platform the retained root's real close is the
        // proof. On Windows only the kernel job's zero-process receipt counts.
        zeroProcesses = true
      }
    },
  })
  async function release() {
    releaseRequested = true
    releaseIfProven()
    if (released) return
    let timer
    try {
      await Promise.race([cleanup, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('The provider cleanup is still unproven; its reservation remains held.'),
          { code: 'AGENT_SESSION_CLEANUP_FAILED' })), cleanupWaitMs)
      })])
    } finally { clearTimeout(timer) }
  }
  return Object.freeze({
    rootLaunch,
    ready() {
      if (!checked || !child || ended || releaseRequested) fail('AGENT_ENGINE_INVALID_SESSION', 'The provider root was not observed alive at session readiness.')
      if ((platform === 'win32' || requireContainment) && typeof child.jobOutcome?.then !== 'function') fail('AGENT_ENGINE_INVALID_SESSION', 'The provider root has no retained process-tree cleanup proof.')
      governor.ready(token)
    },
    release,
    abort() {
      // Startup can throw before the engine hands back close(). Keep a cleanup
      // handle from the moment its actual wrapper/root was constructed.
      if (child && !closed) {
        try {
          if (typeof child.terminateJob === 'function') {
            Promise.resolve(child.terminateJob()).catch(() => {
              try { Promise.resolve(child.terminateRetainedWrapper?.()).catch(() => {}) } catch { /* retain the debit */ }
            })
          } else { child.kill() }
        } catch { /* Cleanup evidence below, never signal success, decides. */ }
      }
      return release()
    },
  })
}

module.exports = Object.freeze({ createSessionResourceLease })
