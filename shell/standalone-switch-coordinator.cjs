'use strict'

// Trusted main-process hooks only. The surface retains this handle; it is not IPC data.
// claimSource is synchronous and returns { sourceSessionId, revision, assertCurrent, release }.
// assertCurrent and release are synchronous; claimSource must unwind its own failed claim.
// startCandidate must retain and clean up failed starts before rejecting. If cleanup is
// unproven, reject with cleanupRequired:true; custody stays held for explicit recovery.
// A returned candidate has a distinct sessionId and has cleared real host readiness.
// prepareHistory returns a provisional same-seat binding; rollbackHistory detaches only
// that linkage, never deletes existing history. Neither hook publishes a replacement.
// commitReplacement owns the final CAS, durable binding and source-retirement boundary.
// It returns applied:true with matching sourceSessionId/sessionId, or applied:false AND
// sourceDisposition:'retained' to prove rollback is safe. Every other outcome is uncertain.
// Cancellation during commit signals the hook, then awaits its disposition. An uncertain
// commit retains candidate, history and source claim; this coordinator never guesses rollback.
const errorFor = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details })
const cancelled = () => errorFor('AGENT_SWITCH_CANCELLED', 'The standalone switch was cancelled.')
const synchronous = value => {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {})
    throw errorFor('AGENT_SWITCH_HOOK_INVALID', 'This source hook must complete synchronously.')
  }
  return value
}
const immutableCopy = value => {
  const copy = structuredClone(value)
  const visited = new WeakSet()
  const freeze = item => {
    if (item && typeof item === 'object' && visited.has(item)) return item
    if (item && typeof item === 'object') {
      visited.add(item)
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
    return item
  }
  return freeze(copy)
}

function createStandaloneSwitchCoordinator(hooks) {
  for (const name of ['claimSource', 'startCandidate', 'closeCandidate', 'prepareHistory', 'rollbackHistory', 'commitReplacement']) {
    if (typeof hooks?.[name] !== 'function') throw errorFor('AGENT_SWITCH_HOOK_INVALID', 'Missing trusted switch hook: ' + name)
  }
  const claims = new Map()

  function prepare(request, context) {
    if (!request || typeof request.sourceSessionId !== 'string' || !request.sourceSessionId) {
      throw errorFor('AGENT_SWITCH_INVALID', 'A standalone switch requires its source session.')
    }
    const input = immutableCopy(request)
    const id = input.sourceSessionId
    if (claims.has(id)) throw errorFor('AGENT_SWITCH_BUSY', 'This source already has a pending standalone switch.')
    const token = {}
    claims.set(id, token)
    let source
    try {
      source = synchronous(hooks.claimSource(input, context))
      if (source?.sourceSessionId !== id || typeof source.assertCurrent !== 'function' || typeof source.release !== 'function') {
        throw errorFor('AGENT_SWITCH_HOOK_INVALID', 'The source claim did not retain the requested session.')
      }
    } catch (error) {
      claims.delete(id)
      throw error
    }

    const sourceRevision = immutableCopy(source.revision)
    const controller = new AbortController()
    let phase = 'preparing'
    let candidate = null
    let candidateSessionId = null
    let history
    let historyPrepared = false
    let candidateClosed = false
    let historyRolledBack = false
    let sourceReleased = false
    let outcome = null
    let failure = null
    let commitPromise = null
    let cancelPromise = null
    let cleanupPromise = null
    let uncertain = false
    let sourceDisposition = 'retained'

    const status = () => Object.freeze({
      phase, sourceSessionId: id, revision: sourceRevision,
      candidateSessionId,
      applied: outcome?.applied === true ? true : uncertain || phase === 'committing' ? null : false,
      ...(outcome?.applied === true ? { receipt: outcome } : {}),
      cancelled: controller.signal.aborted,
      sourceDisposition: outcome?.sourceDisposition || (outcome?.applied ? 'retired' : sourceDisposition),
      ...(failure ? { code: failure.code || 'AGENT_SWITCH_FAILED' } : {}),
    })
    const assertCurrent = () => {
      if (controller.signal.aborted) throw cancelled()
      try {
        const verdict = synchronous(source.assertCurrent())
        if (verdict === false || verdict?.ok === false) throw errorFor('AGENT_SWITCH_SOURCE_CHANGED', 'The source claim is no longer current.')
      } catch (error) {
        sourceDisposition = error?.sourceDisposition || 'unknown'
        throw error
      }
    }
    const release = () => {
      if (!sourceReleased) {
        const verdict = synchronous(source.release())
        if (verdict === false || verdict?.ok === false) throw errorFor('AGENT_SWITCH_CLAIM_RELEASE_FAILED', 'The source claim could not be released.')
        sourceReleased = true
      }
      if (claims.get(id) === token) claims.delete(id)
    }
    const markUncertain = (error, disposition = 'unknown') => {
      uncertain = true
      phase = 'cleanup-required'
      failure = errorFor('AGENT_SWITCH_OUTCOME_UNCERTAIN',
        'The switch outcome requires recovery; the candidate and history remain retained.',
        { sourceDisposition: disposition, cleanupRequired: true, cause: error })
      outcome = { sourceDisposition: disposition }
      return failure
    }
    const cleanup = () => {
      if (uncertain) return Promise.reject(failure)
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        phase = 'rolling-back'
        try {
          if (candidate && !candidateClosed) {
            const closed = await hooks.closeCandidate(candidate)
            if (closed === false || closed?.ok === false || closed?.closed === false) throw errorFor('AGENT_SWITCH_CLEANUP_REQUIRED', 'Candidate closure was refused.')
            candidateClosed = true
          }
          if (historyPrepared && !historyRolledBack) {
            const rolledBack = await hooks.rollbackHistory(history)
            if (rolledBack === false || rolledBack?.ok === false) throw errorFor('AGENT_SWITCH_CLEANUP_REQUIRED', 'Provisional history rollback was refused.')
            historyRolledBack = true
          }
          release()
          phase = controller.signal.aborted ? 'cancelled' : 'failed'
        } catch (error) {
          phase = 'cleanup-required'
          failure = errorFor('AGENT_SWITCH_CLEANUP_REQUIRED',
            'The provisional switch still needs cleanup; its source claim remains held.',
            { sourceDisposition, cleanupRequired: true, cause: error })
          throw failure
        }
      })().finally(() => { cleanupPromise = null })
      return cleanupPromise
    }
    const failPreparation = async error => {
      if (uncertain) throw failure
      if (error?.cleanupRequired === true) throw markUncertain(error, 'retained')
      failure = error
      await cleanup()
      throw error
    }

    const prepared = Promise.resolve().then(async () => {
      try {
        assertCurrent()
        candidate = await hooks.startCandidate({ source, target: input.target, signal: controller.signal })
        candidateSessionId = typeof candidate?.sessionId === 'string' ? candidate.sessionId : null
        if (!candidate || typeof candidate.sessionId !== 'string' || !candidate.sessionId || candidate.sessionId === id) {
          throw markUncertain(errorFor('AGENT_SWITCH_CANDIDATE_UNCONFIRMED', 'Candidate readiness was not retained.'), 'retained')
        }
        assertCurrent()
        history = await hooks.prepareHistory({ source, candidate, signal: controller.signal })
        if (history === undefined || history === null) throw errorFor('AGENT_SWITCH_HISTORY_UNCONFIRMED', 'The provisional history binding was not retained.')
        historyPrepared = true
        assertCurrent()
        phase = 'prepared'
        return Object.freeze({ sourceSessionId: id, sessionId: candidateSessionId })
      } catch (error) { return failPreparation(error) }
    })
    // A caller may only cancel the handle, without separately consuming prepared.
    prepared.catch(() => {})

    const commit = () => {
      if (commitPromise) return commitPromise
      commitPromise = (async () => {
        await prepared
        try { assertCurrent() } catch (error) { return failPreparation(error) }
        phase = 'committing'
        let result
        try {
          result = await hooks.commitReplacement({
            source, candidate, history, signal: controller.signal, assertCurrent,
          })
        } catch (error) { throw markUncertain(error, error?.sourceDisposition || 'unknown') }
        if (result?.applied === false && result.sourceDisposition === 'retained') {
          failure = errorFor(result.code || 'AGENT_SWITCH_NOT_APPLIED',
            'The standalone switch was not applied; the source remains retained.',
            { sourceDisposition: 'retained' })
          await cleanup()
          throw failure
        }
        if (result?.applied !== true || result.sourceSessionId !== id || result.sessionId !== candidateSessionId) {
          throw markUncertain(errorFor('AGENT_SWITCH_RECEIPT_INVALID', 'No matching applied receipt was returned.'),
            result?.sourceDisposition || 'unknown')
        }
        // Applied wins over late cancellation. Never close the now-owned successor.
        try { outcome = immutableCopy(result) } catch (error) { throw markUncertain(error, result.sourceDisposition || 'retired') }
        phase = 'applied'
        try { release() } catch (error) {
          // The replacement is proven applied even if releasing the old claim fails.
          phase = 'applied-cleanup-required'
          failure = errorFor('AGENT_SWITCH_CLAIM_RELEASE_FAILED', 'The switch applied but its prior claim requires cleanup.',
            { applied: true, cleanupRequired: true, receipt: outcome, cause: error })
          throw failure
        }
        return outcome
      })()
      commitPromise.catch(() => {})
      return commitPromise
    }

    const cancel = () => {
      if (cancelPromise) return cancelPromise
      controller.abort()
      cancelPromise = (async () => {
        if (commitPromise) {
          try { await commitPromise } catch { /* Disposition below decides whether rollback is safe. */ }
        } else {
          try { await prepared } catch { /* Preparation already attempted cleanup. */ }
        }
        if (outcome?.applied === true) {
          if (failure?.applied === true) throw failure
          return Object.freeze({ cancelled: false, applied: true, receipt: outcome })
        }
        if (uncertain) throw failure
        await cleanup()
        return Object.freeze({ cancelled: true, applied: false, sourceSessionId: id })
      })().finally(() => { cancelPromise = null })
      cancelPromise.catch(() => {})
      return cancelPromise
    }
    return Object.freeze({ prepared, commit, cancel, status })
  }
  return Object.freeze({ prepare })
}

module.exports = { createStandaloneSwitchCoordinator }
