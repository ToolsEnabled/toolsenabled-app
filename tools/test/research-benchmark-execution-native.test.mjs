import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutionLedger } from '../../src/benchmark/execution.mjs'
import { executionCents, verifyNativeExecution } from '../../src/benchmark/execution-lean.mjs'

function fixture() {
  const config = { version: 1, cashCents: 10000, currency: 'USD', assets: [{ id: 'SPY', multiplier: 1, quantityStep: 1 }],
    owners: ['root/a'], limits: { intents: 10, events: 20 } }
  const intent = { id: 'entry', owner: 'root/a', lotId: 'lot', asset: 'SPY', side: 'buy', quantity: 4, cashCapCents: 4000, reason: 'entry', time: 1704205860 }
  const ledger = createExecutionLedger(config)
  ledger.admit(intent)
  const events = [
    { orderId: 1, orderEventId: 1, symbolValue: 'SPY', status: 'submitted', time: intent.time, fillQuantity: 0, fillPrice: 0, fillPriceCurrency: 'USD' },
    { orderId: 1, orderEventId: 2, symbolValue: 'SPY', status: 'partiallyFilled', time: intent.time + 60, fillQuantity: 2, fillPrice: 10, fillPriceCurrency: 'USD', orderFeeAmount: 0, orderFeeCurrency: 'USD' },
    { orderId: 1, orderEventId: 3, symbolValue: 'SPY', status: 'filled', time: intent.time + 120, fillQuantity: 2, fillPrice: 10, fillPriceCurrency: 'USD', orderFeeAmount: 0, orderFeeCurrency: 'USD' },
  ]
  ledger.reconcile({ id: '1:1', intentId: 'entry', brokerOrderId: '1', kind: 'accepted', time: intent.time })
  ledger.reconcile({ id: '1:2', intentId: 'entry', brokerOrderId: '1', kind: 'fill', time: intent.time + 60, quantity: 2, priceCents: 1000, feeCents: 0 })
  ledger.reconcile({ id: '1:3', intentId: 'entry', brokerOrderId: '1', kind: 'fill', time: intent.time + 120, quantity: 2, priceCents: 1000, feeCents: 0 })
  const result = { state: { Status: 'Completed', RuntimeError: '' }, orders: { 1: { id: 1, type: 0, symbol: { value: 'SPY' }, quantity: 4, status: 3,
    time: new Date(intent.time * 1000).toISOString(), tag: '["LB-EXEC-1","entry"]' } } }
  return { config, result, events, actions: [{ kind: 'intent', intent }], journal: ledger.snapshot().journal }
}

test('native receipts reconstruct private state with explicit partial-fill chronology and exact fees', () => {
  const actual = verifyNativeExecution(fixture())
  assert.equal(actual.cashCents, 6000); assert.equal(actual.reservedCashCents, 0)
  assert.equal(actual.lots[0].quantity, 4); assert.equal(actual.tickets[0].status, 'filled')
  assert.equal(actual.events.filter(event => event.kind === 'fill').length, 2)
  assert.equal(executionCents('1.23e2'), 12300)
  assert.equal(executionCents('0.00'), 0)
  assert.throws(() => executionCents('0.001'), /sub-cent/)
  assert.throws(() => executionCents('1e1000'), /exact range/)
})

test('candidate journals cannot hide native orders, fees, assignments, missing fills or changed identities', () => {
  const mutations = [
    input => { input.events[1].orderFeeAmount = 1 },
    input => { delete input.events[1].orderFeeAmount },
    input => { input.events[1].orderFeeCurrency = 'EUR' },
    input => { input.events[1].isAssignment = true },
    input => { input.events[1].symbolValue = 'QQQ' },
    input => { input.events[1].fillQuantity = -2 },
    input => { input.events[1].orderEventId = 1 },
    input => { input.events.splice(1, 1) },
    input => { input.events.push({ ...input.events[2], orderId: 2 }) },
    input => { input.result.orders[1].tag = '["LB-EXEC-1","foreign"]' },
    input => { input.result.orders[1].quantity = 5 },
    input => { input.result.orders[2] = { ...input.result.orders[1], id: 2 } },
    input => { input.result.orders[1].time = '2024-01-02T14:32:00Z' },
    input => { input.actions[0].intent.cashCapCents = 3000 },
    input => { input.journal[0].decision.admitted = false },
  ]
  for (const mutate of mutations) {
    const input = fixture(); mutate(input)
    assert.throws(() => verifyNativeExecution(input), undefined, mutate.toString())
  }
})

test('native completion and each order status must agree with retained partial and full receipts', () => {
  for (const mutate of [
    input => { input.result.state.Status = 'RuntimeError' },
    input => { input.result.state.RuntimeError = 'error' },
    input => { input.result.orders[1].status = 2 },
    input => { input.events[1].status = 'filled' },
    input => { input.events[2].status = 'partiallyFilled' },
  ]) {
    const input = fixture(); mutate(input)
    assert.throws(() => verifyNativeExecution(input))
  }
})

test('pending receipts cannot carry hidden inventory or money and unhandled updates fail closed', () => {
  for (const modify of [
    event => { event.fillQuantity = 1 },
    event => { event.orderFeeAmount = 1 },
    event => { event.status = 'updateSubmitted' },
    event => { event.time -= 60 },
  ]) {
    const input = fixture(); modify(input.events[0])
    assert.throws(() => verifyNativeExecution(input))
  }
})
