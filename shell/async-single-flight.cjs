'use strict'

/* One asynchronous construction, shared by every caller that arrives before
 * it settles. The slot is cleared after either outcome so a genuine later
 * retry can run; callers in the same startup window receive the exact same
 * promise and therefore cannot construct duplicate process/event hosts. */
function asyncSingleFlight(factory) {
  if (typeof factory !== 'function') throw new TypeError('asyncSingleFlight requires a factory')
  let inFlight = null
  return function runSingleFlight() {
    if (inFlight) return inFlight
    const operation = Promise.resolve().then(factory)
    inFlight = operation
    void operation.then(
      () => { if (inFlight === operation) inFlight = null },
      () => { if (inFlight === operation) inFlight = null },
    )
    return operation
  }
}

module.exports = { asyncSingleFlight }
