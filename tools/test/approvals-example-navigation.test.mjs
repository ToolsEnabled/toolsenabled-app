import assert from 'node:assert/strict'
import test from 'node:test'

import { gotoApprovals } from '../approvals-example-qa.mjs'

test('the approvals walk stops on the hash while the rendered route lags behind', async () => {
  const state = {
    hash: '#/research',
    route: 'research',
    face: null,
    pageActive: false,
    inert: false,
  }
  let clicks = 0
  let pauses = 0
  const window = {
    async evaluate() { return { ...state } },
    async clickVisible(selector) {
      if (selector === '[data-mode="p"]') {
        state.face = 'demonstration'
        state.pageActive = true
        return 'clicked'
      }
      assert.equal(selector, '#nav-next')
      clicks += 1
      state.hash = '#/ledger'
      return 'clicked'
    },
  }
  const pause = async () => {
    pauses += 1
    /* The first observation after the click deliberately sees the old body
       route. Only the next poll completes the render. A route-led loop would
       click again here and pass approvals. */
    if (pauses === 2) {
      state.route = 'ledger'
    }
  }

  const reached = await gotoApprovals(window, { pause, maxSteps: 3, syncAttempts: 4, pollMs: 0 })

  assert.equal(reached.status, 'clicked')
  assert.equal(clicks, 1, 'the arrow was pressed again after the hash had already reached approvals')
  assert.deepEqual(reached.state, {
    hash: '#/ledger',
    route: 'ledger',
    face: 'demonstration',
    pageActive: true,
    inert: false,
  })
})
