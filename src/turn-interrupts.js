/* The host may publish turn_completed before interrupt() resolves. Hold that
 * completion until Stop is proven. A retryable cleanup refusal keeps the
 * completion waiting; ordinary refusals keep the ordinary completion path. */
export function createTurnInterrupts() {
  const pending = new Map()
  const completions = new Map()
  const accepted = new Map()
  const matches = (left, right) => !left || !right || left === right
  const release = (sessionId, completion) => {
    completion?.resolve()
    if (completions.get(sessionId) === completion) completions.delete(sessionId)
  }
  return {
    request(sessionId, turnId, interrupt) {
      const held = pending.get(sessionId)
      if (held) return held.promise
      let completion = completions.get(sessionId)
      if (!completion || !matches(completion.turnId, turnId)) {
        release(sessionId, completion)
        completion = { turnId: turnId || null, resolve: null }
        completion.promise = new Promise(resolve => { completion.resolve = resolve })
        completions.set(sessionId, completion)
      }
      const flight = { turnId: turnId || completion.turnId, promise: null }
      pending.set(sessionId, flight)
      flight.promise = Promise.resolve().then(interrupt).then(result => {
        if (pending.get(sessionId) === flight) {
          const acknowledgedTurn = typeof result?.turnId === 'string' && result.turnId ? result.turnId : flight.turnId
          accepted.set(sessionId, acknowledgedTurn)
        }
        release(sessionId, completion)
        return result
      }, error => {
        // IPC errors may retain the code as a property or in their message.
        if (error?.code !== 'AGENT_STOP_PENDING' && !/\bAGENT_STOP_PENDING\b/.test(String(error?.message || ''))) {
          release(sessionId, completion)
        }
        throw error
      }).finally(() => {
        if (pending.get(sessionId) === flight) pending.delete(sessionId)
      })
      return flight.promise
    },
    pending(sessionId, turnId) {
      const completion = completions.get(sessionId)
      if (!completion || !matches(completion.turnId, turnId)) return null
      if (!completion.turnId && turnId) {
        completion.turnId = turnId
        const flight = pending.get(sessionId)
        if (flight && !flight.turnId) flight.turnId = turnId
      }
      return completion.promise
    },
    consume(sessionId, turnId) {
      if (!accepted.has(sessionId)) return false
      const stoppedTurn = accepted.get(sessionId)
      accepted.delete(sessionId)
      return matches(stoppedTurn, turnId)
    },
    forget(sessionId) { pending.delete(sessionId); accepted.delete(sessionId); release(sessionId, completions.get(sessionId)) },
    clear() {
      pending.clear(); accepted.clear()
      for (const [sessionId, completion] of completions) release(sessionId, completion)
    },
  }
}
