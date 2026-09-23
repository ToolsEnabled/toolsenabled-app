import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const { messageDeliveryDecision: decide } = createRequire(import.meta.url)('../../shell/agent-message-delivery.cjs')

const base = { mode: 'instant', intervalMs: 30_000, queuedSince: 1000, now: 1001,
  active: true, canSteer: true, boundaryAllowed: false, queued: 1 }
test('Instant can deliver during work; End of turn never does', () => {
  assert.equal(decide(base), 'steer')
  assert.equal(decide({ ...base, mode: 'end-of-turn' }), 'wait')
  assert.equal(decide({ ...base, canSteer: false }), 'wait')
  assert.equal(decide({ ...base, active: false, boundaryAllowed: true }), 'turn')
  assert.equal(decide({ ...base, paused: true }), 'wait')
})
test('Timer batches from the first message, even across a turn boundary', () => {
  assert.equal(decide({ ...base, mode: 'timer', now: 30_999 }), 'wait')
  assert.equal(decide({ ...base, mode: 'timer', now: 31_000 }), 'steer')
  assert.equal(decide({ ...base, mode: 'timer', active: false, boundaryAllowed: true }), 'wait')
  assert.equal(decide({ ...base, mode: 'timer', now: 31_000, active: false, boundaryAllowed: true }), 'turn')
})
test('Empty queues, paused agents and user boundary reservations are respected', () => {
  assert.equal(decide({ ...base, queued: 0 }), 'wait')
  assert.equal(decide({ ...base, active: false }), 'wait')
  assert.equal(decide({ ...base, mode: 'timer', now: 31_000, paused: true }), 'wait')
})
