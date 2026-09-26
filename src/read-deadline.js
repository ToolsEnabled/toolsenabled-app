/* A READ THAT CANNOT OUTLIVE ITS BUDGET.
 *
 * WHY THIS EXISTS AS ITS OWN FILE. It was four lines inside src/views/account.js
 * and unreachable by any test, because that view imports three stylesheets and a
 * plain `node --test` cannot parse them. This project has already paid for that
 * once: two planted defects survived every assertion that searched source text,
 * and the note in views/account.js draws the conclusion -- builders a test can
 * CALL are the only thing that catches them. So the budget lives here, where a
 * test calls it.
 *
 * WHAT PROBLEM IT SOLVES, MEASURED RATHER THAN ASSUMED. The purchase-list row
 * reads its queue through src/mission-bridge.js, and that read is four hops, each
 * carrying its own 30-second budget: wait for the shell to settle its capability
 * layer, confirm the pinned origin, exchange this boot's bootstrap proof for a
 * bearer, then the request. Every one of those budgets is defensible on its own
 * and they ADD. The worst case is near two minutes in which the only thing the
 * screen says is that it is still reading.
 *
 * That is the failure mode this product cannot afford. A surface that waits with
 * no error is indistinguishable from a broken one, and gives a person nothing to
 * act on. On the money surface it is worse than indistinguishable: doing nothing
 * to a purchase list is a DENIAL at its expiry date, so a row that quietly asks
 * somebody to keep waiting is asking them to keep not-deciding.
 *
 * IT REJECTS, IT DOES NOT RESOLVE TO A SENTINEL. Every caller already treats a
 * thrown read and an unreadable reply as one refusal, so a third "gave up" value
 * would be a state nobody renders and everybody has to remember.
 *
 * IT DOES NOT CANCEL THE WORK, AND DOES NOT PRETEND TO. The fetch underneath
 * owns its own abort signal and this has no access to it. What this bounds is
 * what the SCREEN waits for. Saying so matters, because a caller that believed
 * this cancelled would be wrong about whether a request reached the far side --
 * which on a write would be a serious thing to be wrong about. Read paths only.
 */

/**
 * Resolve with `promise` if it settles within `ms`; otherwise reject.
 *
 * The timer is cleared on EITHER outcome. An uncleared timer keeps a Node test
 * process alive past its assertions and keeps a renderer's event loop warm for
 * no reason, and it is the specific bug that makes a "timeout" helper feel
 * haunted -- the work finished, and something still fires later.
 *
 * @param {Promise<T>} promise the read to bound
 * @param {number} ms whole milliseconds; must be finite and positive
 * @param {string} [what] named in the rejection, so a log says which read gave up
 * @returns {Promise<T>}
 * @template T
 */
export function withDeadline(promise, ms, what = 'the read') {
  if (!Number.isFinite(ms) || ms <= 0) {
    /* A budget of zero, NaN or a negative number is a programming error, not a
       very short deadline. Treating it as "expire immediately" would turn one
       mistyped constant into a surface that refuses everything and blames the
       network for it. */
    throw new TypeError('a read deadline must be a positive number of milliseconds')
  }
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer !== null) { clearTimeout(timer); timer = null }
    }),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timer = null
        reject(new Error(`${what} did not answer within ${ms}ms`))
      }, ms)
    }),
  ])
}
