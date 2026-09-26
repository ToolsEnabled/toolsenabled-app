import { PYTHON_COMMAND, PYTHON_ARGS } from './lib/python-command.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createExecutionLedger, replayExecutionLedger } from '../../src/benchmark/execution.mjs'

const config = () => ({ version: 1, cashCents: 100, currency: 'USD', assets: [{ id: 'XYZ', multiplier: 1, quantityStep: 1 }], owners: ['root/A', 'root/B'], limits: { intents: 100, events: 1000 } })
const buy = (id, owner, lotId, quantity, cashCapCents, time = 0) => ({ id, owner, lotId, asset: 'XYZ', side: 'buy', quantity, cashCapCents, reason: 'entry', time })
const sell = (id, owner, lotId, quantity, time) => ({ ...buy(id, owner, lotId, quantity, 0, time), side: 'sell', reason: 'exit' })
const event = (id, intentId, brokerOrderId, kind, time, rest = {}) => ({ id, intentId, brokerOrderId, kind, time, ...rest })
const fill = (id, intentId, order, quantity, time, priceCents = 10, feeCents = 0) => event(id, intentId, order, 'fill', time, { quantity, priceCents, feeCents })

test('configuration versions and identifier boundaries have the same JSON meaning in both runtimes', () => {
  const inputs = [true, 1, '1', null].map(version => ({ ...config(), version }))
  for (const currency of ['\ufeff', '\u0085', 'X'.repeat(241), '😀'.repeat(120), '😀'.repeat(121)]) inputs.push({ ...config(), currency })
  const expected = inputs.map(input => { try { createExecutionLedger(input); return true } catch { return false } })
  assert.deepEqual(expected, [false, true, false, false, false, true, false, true, false])
  const source = fileURLToPath(new URL('../../src/benchmark/execution_reference.py', import.meta.url))
  const python = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-c', 'import json,runpy,sys\nLedger=runpy.run_path(sys.argv[1])["ExecutionLedger"]\nresults=[]\nfor config in json.load(sys.stdin):\n try: Ledger(config); results.append(True)\n except (ValueError,KeyError,TypeError): results.append(False)\nprint(json.dumps(results))', source], { encoding: 'utf8', input: JSON.stringify(inputs), timeout: 10000 })
  assert.equal(python.status, 0, python.stderr); assert.deepEqual(JSON.parse(python.stdout), expected)
})

test('delayed and partial fills preserve two same-asset owners through cancellation and private exits', () => {
  const ledger = createExecutionLedger(config())
  assert.equal(ledger.admit(buy('a-buy', 'root/A', 'a-lot', 4, 40)).admitted, true)
  assert.equal(ledger.admit(buy('b-buy', 'root/B', 'b-lot', 4, 40)).admitted, true)
  assert.deepEqual(ledger.status(['root/A']), { active: false, pending: true, resettable: false })
  assert.equal(ledger.snapshot().cashCents, 100, 'Admission reserves funds but is not a fill')
  assert.equal(ledger.snapshot().availableCashCents, 20)
  ledger.reconcile(event('accepted-a', 'a-buy', 'order-a', 'accepted', 1))
  ledger.reconcile(fill('a-partial', 'a-buy', 'order-a', 2, 2))
  ledger.reconcile(fill('b-filled', 'b-buy', 'order-b', 4, 3))
  assert.equal(ledger.snapshot().cashCents, 40)
  assert.equal(ledger.admit(sell('a-oversell', 'root/A', 'a-lot', 4, 3)).reason, 'insufficient-unreserved-private-quantity')
  assert.equal(ledger.admit(sell('a-exit', 'root/A', 'a-lot', 2, 3)).admitted, true)
  ledger.requestCancel('a-buy', 4)
  ledger.reconcile(fill('a-after-request', 'a-buy', 'order-a', 1, 5))
  assert.equal(ledger.snapshot().tickets.find(ticket => ticket.id === 'a-buy').status, 'partially-filled')
  assert.deepEqual(ledger.status(['root/A']), { active: true, pending: true, resettable: false })
  ledger.reconcile(event('a-cancelled', 'a-buy', 'order-a', 'cancelled', 6))
  assert.equal(ledger.snapshot().cashCents, 30)
  assert.equal(ledger.snapshot().reservedCashCents, 0)
  ledger.reconcile(fill('a-exited', 'a-exit', 'order-exit-a', 2, 7))
  ledger.admit(sell('a-remainder', 'root/A', 'a-lot', 1, 8))
  ledger.reconcile(fill('a-last-fill', 'a-remainder', 'order-last-a', 1, 9))
  const result = ledger.snapshot(), a = result.lots.find(lot => lot.id === 'a-lot'), b = result.lots.find(lot => lot.id === 'b-lot')
  assert.equal(result.cashCents, 60); assert.deepEqual(result.positions, [{ asset: 'XYZ', quantity: 4 }])
  assert.equal(a.boughtQuantity, 3); assert.equal(a.soldQuantity, 3); assert.equal(a.roundTripComplete, true)
  assert.equal(a.firstFillTime, 2); assert.equal(b.quantity, 4)
  assert.deepEqual(ledger.status(['root/A']), { active: false, pending: false, resettable: true })
  assert.deepEqual(ledger.status(['root/A', 'root/B']), { active: true, pending: false, resettable: false })
  assert.deepEqual(replayExecutionLedger(config(), result.journal).snapshot(), result)
})

test('rejection, expiry and zero-fill cancellation release only their remaining cash reservation', () => {
  for (const kind of ['rejected', 'expired', 'cancelled']) {
    const ledger = createExecutionLedger(config())
    ledger.admit(buy('a', 'root/A', 'lot', 4, 40))
    if (kind === 'cancelled') ledger.requestCancel('a', 1)
    ledger.reconcile(event('end', 'a', 'native-a', kind, 2))
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.availableCashCents, 100); assert.equal(snapshot.lots[0].quantity, 0)
    assert.equal(snapshot.lots[0].roundTripComplete, false, 'A rejected entry is not a completed round trip')
    assert.deepEqual(ledger.status(['root/A']), { active: false, pending: false, resettable: true })
    assert.throws(() => ledger.reconcile(fill('late', 'a', 'native-a', 1, 3)), /terminal ticket/)
    assert.deepEqual(ledger.snapshot(), snapshot)
  }
})

test('idempotent broker events cannot rewrite prices, move native order ownership or overfill a ticket', () => {
  const ledger = createExecutionLedger(config())
  ledger.admit(buy('a', 'root/A', 'a-lot', 4, 40)); ledger.admit(buy('b', 'root/B', 'b-lot', 4, 40))
  const first = fill('first', 'a', 'native-a', 2, 1)
  ledger.reconcile(first); ledger.reconcile(event('b-accepted', 'b', 'native-b', 'accepted', 2))
  const before = ledger.snapshot()
  assert.deepEqual(ledger.reconcile(first), { applied: false, duplicate: true })
  assert.deepEqual(ledger.snapshot(), before)
  assert.throws(() => ledger.reconcile({ ...first, priceCents: 9 }), /duplicate broker event changed/)
  assert.throws(() => ledger.reconcile(fill('foreign', 'b', 'native-a', 1, 3)), /cannot move between private intents/)
  assert.throws(() => ledger.reconcile(fill('too-many', 'a', 'native-a', 3, 3)), /exceeds its admitted quantity/)
  assert.deepEqual(ledger.snapshot(), before, 'Invalid transitions must not half-update lots, cash, identifiers or reservations')
})

test('synchronous fill before submit returns cannot be resurrected by a later acceptance acknowledgment', () => {
  const ledger = createExecutionLedger(config())
  ledger.admit(buy('a', 'root/A', 'a-lot', 2, 30))
  ledger.reconcile(fill('first', 'a', 'native-a', 2, 1))
  ledger.reconcile(event('ack', 'a', 'native-a', 'accepted', 1))
  const result = ledger.snapshot()
  assert.equal(result.tickets[0].status, 'filled'); assert.equal(result.cashCents, 80); assert.equal(result.reservedCashCents, 0)
  assert.deepEqual(ledger.status(['root/A']), { active: true, pending: false, resettable: false })
})

test('cash caps, lot reservations and rejected intent identities are enforced before dispatch', () => {
  const ledger = createExecutionLedger(config())
  ledger.admit(buy('a', 'root/A', 'a-lot', 8, 80))
  const rejected = buy('b', 'root/B', 'b-lot', 3, 30)
  assert.equal(ledger.admit(rejected).reason, 'insufficient-unreserved-cash')
  assert.throws(() => ledger.admit(rejected), /cannot be reused/)
  ledger.reconcile(fill('a-filled', 'a', 'native-a', 8, 1))
  ledger.admit(sell('exit-a', 'root/A', 'a-lot', 7, 2))
  assert.equal(ledger.admit(sell('exit-again', 'root/A', 'a-lot', 2, 2)).admitted, false)
  assert.throws(() => ledger.admit(sell('foreign', 'root/B', 'a-lot', 1, 2)), /same owner/)
  assert.equal(ledger.snapshot().lots[0].reservedQuantity, 7)
  ledger.requestCancel('exit-a', 3)
  assert.equal(ledger.snapshot().lots[0].reservedQuantity, 7, 'A request does not release sell reservations')
  ledger.reconcile(event('cancel-ack', 'exit-a', 'exit-order', 'cancelled', 4))
  assert.equal(ledger.snapshot().lots[0].reservedQuantity, 0)
})

test('explicit asset multipliers and fees change exact cash, and a failed cap check is transactional', () => {
  const input = config(); input.cashCents = 10000; input.assets[0].multiplier = 100
  const ledger = createExecutionLedger(input)
  ledger.admit(buy('a', 'root/A', 'lot', 3, 7509))
  const before = ledger.snapshot()
  assert.throws(() => ledger.reconcile(fill('over-cap', 'a', 'order-a', 3, 1, 25, 10)), /reserved cash cap/)
  assert.deepEqual(ledger.snapshot(), before)
  ledger.reconcile(fill('filled', 'a', 'order-a', 3, 1, 25, 9))
  ledger.admit(sell('exit', 'root/A', 'lot', 1, 2))
  ledger.reconcile(fill('exited', 'exit', 'order-exit', 1, 3, 30, 3))
  assert.equal(ledger.snapshot().cashCents, 5488)
  assert.equal(ledger.snapshot().tickets[0].grossCents, 7500)
  assert.equal(ledger.snapshot().lots[0].quantity, 2)
})

test('declared configuration, input ordering and exported snapshots cannot be mutated from outside', () => {
  const input = config(), ledger = createExecutionLedger(input); input.assets[0].multiplier = 100
  const intent = buy('a', 'root/A', 'lot', 2, 20)
  ledger.admit(intent); intent.quantity = 10
  const copy = ledger.snapshot(); copy.tickets[0].quantity = 999
  ledger.reconcile(fill('a-filled', 'a', 'native-a', 2, 4))
  assert.equal(ledger.snapshot().cashCents, 80); assert.equal(ledger.snapshot().tickets[0].quantity, 2)
  assert.throws(() => ledger.reconcile(event('old-ack', 'a', 'native-a', 'accepted', 3)), /nondecreasing/)
  assert.throws(() => ledger.reconcile(event('fake-fill', 'a', 'native-a', 'accepted', 5, { quantity: 1 })), /silently carry fill/)
  assert.throws(() => createExecutionLedger({ ...config(), cashCents: 0.5 }), /integer cash/)
})

test('one ordered execution journal retains interleaved decisions and receipts and refuses reordered or fabricated admission', () => {
  const ledger = createExecutionLedger(config())
  ledger.admit(buy('a', 'root/A', 'a-lot', 4, 80))
  ledger.reconcile(fill('a-fill', 'a', 'native-a', 4, 0))
  ledger.admit(buy('b', 'root/B', 'b-lot', 5, 50, 0))
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.decisions[1].admitted, true)
  assert.deepEqual(snapshot.journal.map(row => (row.event || row.decision).sequence), [1, 2, 3])
  assert.deepEqual(replayExecutionLedger(config(), snapshot.journal).snapshot(), snapshot)
  const changed = structuredClone(snapshot.journal); [changed[1], changed[2]] = [changed[2], changed[1]]
  assert.throws(() => replayExecutionLedger(config(), changed), /sequence changed/)
  const falseDecision = structuredClone(snapshot.journal); falseDecision[2].decision.admitted = false
  assert.throws(() => replayExecutionLedger(config(), falseDecision), /admission decision disagrees/)
})

test('frozen resource limits include rejected intentions and new receipts while exact duplicate receipts remain idempotent', () => {
  const input = config(); input.limits = { intents: 2, events: 1 }
  const ledger = createExecutionLedger(input)
  ledger.admit(buy('a', 'root/A', 'lot-a', 2, 100))
  assert.equal(ledger.admit(buy('rejected', 'root/B', 'lot-b', 1, 10)).admitted, false)
  assert.throws(() => ledger.admit(buy('over-budget', 'root/B', 'lot-c', 1, 10)), /intent budget/)
  const accepted = event('accepted', 'a', 'native-a', 'accepted', 1)
  ledger.reconcile(accepted)
  const before = ledger.snapshot()
  assert.equal(ledger.reconcile(accepted).duplicate, true)
  assert.throws(() => ledger.reconcile(fill('budget-full', 'a', 'native-a', 1, 2)), /event budget/)
  assert.throws(() => ledger.requestCancel('a', 2), /event budget/)
  assert.deepEqual(ledger.snapshot(), before)
})

test('separately implemented Python reconciliation agrees on seeded partial-fill, cancellation, ownership and invalid-event histories', () => {
  let state = 90210
  const next = () => { state = Math.imul(state, 1664525) + 1013904223 >>> 0; return state }
  const examples = Array.from({ length: 40 }, (_, index) => {
    const input = config(); input.cashCents = 1000; input.assets[0].multiplier = index % 3 + 1
    const quantity = 3 + next() % 6, multiplier = input.assets[0].multiplier, first = 1 + next() % (quantity - 1), cancel = index % 2 === 0
    const actions = [], expectedErrors = []
    const intent = value => actions.push({ kind: 'intent', intent: value }), receipt = value => actions.push({ kind: 'event', event: value })
    intent(buy('a', 'root/A', 'a-lot', quantity, quantity * 15 * multiplier))
    intent(buy('b', 'root/B', 'b-lot', 2, 30 * multiplier))
    receipt(event('a-accepted', 'a', 'native-a', 'accepted', 1))
    const firstFill = fill('first', 'a', 'native-a', first, 2)
    receipt(firstFill); receipt(fill('b-full', 'b', 'native-b', 2, 2))
    receipt(firstFill)
    expectedErrors.push(actions.length); receipt({ ...firstFill, quantity: true })
    expectedErrors.push(actions.length); receipt(fill('wrong-owner', 'b', 'native-a', 1, 2))
    expectedErrors.push(actions.length); intent(sell('foreign', 'root/B', 'a-lot', 1, 2))
    let held = first
    if (cancel) {
      actions.push({ kind: 'cancel', intentId: 'a', time: 3 })
      if (quantity - first > 1) { receipt(fill('during-cancel', 'a', 'native-a', 1, 4)); held++ }
      receipt(event('cancelled', 'a', 'native-a', 'cancelled', 5))
    } else { receipt(fill('last-entry', 'a', 'native-a', quantity - first, 3, 12)); held = quantity }
    expectedErrors.push(actions.length); receipt(fill('late-overfill', 'a', 'native-a', 1, 6))
    intent(sell('a-exit', 'root/A', 'a-lot', held, 7))
    receipt(fill('a-exit-fill', 'a-exit', 'native-exit', held, 8, 14, 1))
    expectedErrors.push(actions.length); receipt(event('nonfill-with-values', 'a-exit', 'native-exit', 'accepted', 9, { feeCents: 0 }))
    return { config: input, actions, expectedErrors }
  })
  const expected = examples.map(example => {
    const ledger = createExecutionLedger(example.config), errors = []
    example.actions.forEach((action, index) => {
      try {
        if (action.kind === 'intent') ledger.admit(action.intent)
        else if (action.kind === 'event') ledger.reconcile(action.event)
        else ledger.requestCancel(action.intentId, action.time)
      } catch { errors.push(index) }
    })
    assert.deepEqual(errors, example.expectedErrors)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.lots.find(lot => lot.id === 'a-lot').roundTripComplete, true)
    assert.equal(snapshot.lots.find(lot => lot.id === 'b-lot').quantity, 2)
    return { errors, snapshot }
  })
  const python = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, fileURLToPath(new URL('../../src/benchmark/execution_reference.py', import.meta.url))], { encoding: 'utf8', input: JSON.stringify(examples), maxBuffer: 16 * 1024 * 1024, timeout: 10000 })
  assert.equal(python.status, 0, python.stderr)
  assert.deepEqual(JSON.parse(python.stdout), expected)
})
