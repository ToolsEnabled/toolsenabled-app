const DEFAULT_DEADLINE_MS = 12_000
const DEFAULT_ATTEMPTS = 3
const TWO_FRAMES = 'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))'

function withDeadline(promise, deadlineMs, label) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer in ${deadlineMs}ms`)), deadlineMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

/* A BrowserWindow created with show:false can finish layout without creating a
 * compositor hit-test surface. In that state elementFromPoint returns <html>
 * for every coordinate, including a fixed maximum-z-index button. The bounded
 * wake sequence below is the one measured and documented by the shared test
 * account harness: force an active lifecycle, dispatch real CDP mouse input,
 * then allow two frames. Keep wake and evaluation in one operation so a caller
 * cannot accidentally measure the pre-wake DOM and call it input. */
export function createCompositedPageMeasure({
  session,
  evaluate,
  deadlineMs = DEFAULT_DEADLINE_MS,
  attempts = DEFAULT_ATTEMPTS,
}) {
  if (!session || typeof session.send !== 'function') throw new TypeError('session.send is required')
  if (typeof evaluate !== 'function') throw new TypeError('evaluate is required')
  if (!(deadlineMs > 0)) throw new TypeError('deadlineMs must be positive')
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('attempts must be a positive integer')

  let move = 0
  return async expression => {
    await withDeadline(
      session.send('Page.setWebLifecycleState', { state: 'active' }),
      deadlineMs,
      'the lifecycle change',
    )
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const x = 4 + (move++ % 3)
        await withDeadline(
          session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 4, button: 'none' }),
          deadlineMs,
          'the compositor wake input',
        )
        await withDeadline(evaluate(TWO_FRAMES), deadlineMs, 'the two-frame paint nudge')
        return evaluate(expression)
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`the hidden page did not complete its compositor wake after ${attempts} attempt(s): ${lastError?.message || lastError}`)
  }
}

export const compositedPageMeasureTwoFramesExpression = TWO_FRAMES
