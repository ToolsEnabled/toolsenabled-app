import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compositedPageMeasureTwoFramesExpression,
  createCompositedPageMeasure,
} from '../lib/composited-page-measure.mjs'

test('the exact bounded wake completes before the hit-test-bearing expression', async () => {
  const order = []
  const measure = createCompositedPageMeasure({
    session: {
      send: async (method, parameters) => {
        order.push(['cdp', method, parameters])
        return { result: {} }
      },
    },
    evaluate: async expression => {
      order.push(['evaluate', expression])
      return expression === 'hitTest()' ? { hits: 9 } : true
    },
  })

  assert.deepEqual(await measure('hitTest()'), { hits: 9 })
  assert.deepEqual(order, [
    ['cdp', 'Page.setWebLifecycleState', { state: 'active' }],
    ['cdp', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none' }],
    ['evaluate', compositedPageMeasureTwoFramesExpression],
    ['evaluate', 'hitTest()'],
  ])
})

test('successive measurements move the real pointer by one pixel before measuring', async () => {
  const moves = []
  const measure = createCompositedPageMeasure({
    session: { send: async (method, parameters) => {
      if (method === 'Input.dispatchMouseEvent') moves.push(parameters.x)
      return { result: {} }
    } },
    evaluate: async expression => expression,
  })
  await measure('first')
  await measure('second')
  await measure('third')
  assert.deepEqual(moves, [4, 5, 6])
})

test('wake failures exhaust bounded retries and never evaluate the measured expression', async () => {
  const expressions = []
  const moves = []
  const measure = createCompositedPageMeasure({
    session: { send: async (method, parameters) => {
      if (method === 'Input.dispatchMouseEvent') moves.push(parameters.x)
      return { result: {} }
    } },
    evaluate: async expression => {
      expressions.push(expression)
      if (expression === compositedPageMeasureTwoFramesExpression) throw new Error('no frame')
      return true
    },
  })
  await assert.rejects(measure('hitTest()'), /did not complete its compositor wake after 3 attempt.*no frame/)
  assert.deepEqual(moves, [4, 5, 6])
  assert.deepEqual(expressions, Array(3).fill(compositedPageMeasureTwoFramesExpression))
})

test('construction rejects incomplete collaborators', () => {
  assert.throws(() => createCompositedPageMeasure({ session: {}, evaluate: async () => {} }), /session\.send/)
  assert.throws(() => createCompositedPageMeasure({ session: { send: async () => ({}) } }), /evaluate/)
  assert.throws(() => createCompositedPageMeasure({ session: { send: async () => ({}) }, evaluate: async () => {}, deadlineMs: 0 }), /deadlineMs/)
  assert.throws(() => createCompositedPageMeasure({ session: { send: async () => ({}) }, evaluate: async () => {}, attempts: 0 }), /attempts/)
})
