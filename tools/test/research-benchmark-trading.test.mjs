import { PYTHON_COMMAND, PYTHON_ARGS } from './lib/python-command.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTradingRuntime } from '../../src/benchmark/trading-runtime.mjs'
import { validateTradingIR } from '../../src/benchmark/trading-ir.mjs'
import { strategy, template, tradingCase, tradingHarness } from './fixtures/trading-operational-cases.mjs'

test('the four-role IR preserves nested 2/3/4-child order, scopes and private owners', async () => {
  const { ir } = await tradingCase(template('all', [strategy(), template('sequence', [strategy(), strategy(), template('race', [strategy(), strategy(), strategy(), strategy()])])]))
  assert.deepEqual(ir.nodes.map(row => [row.namespace, row.parent, row.children, row.scopeEnd]), [
    ['n0', null, [1, 2], 10], ['n1', 0, [], 2], ['n2', 0, [3, 4, 5], 10], ['n3', 2, [], 4], ['n4', 2, [], 5],
    ['n5', 2, [6, 7, 8, 9], 10], ['n6', 5, [], 7], ['n7', 5, [], 8], ['n8', 5, [], 9], ['n9', 5, [], 10],
  ])
  assert.deepEqual(ir.execution.owners, ['n1', 'n3', 'n4', 'n6', 'n7', 'n8', 'n9'])
  assert.equal(ir.nodes[1].roles.buy_reason.rule.asset, 'SPY')
  assert.match(ir.nodes[6].roles.sell_process.requirementId, /^root\/child1\/child2\/child0\/sell_process#/)
  assert.equal(createTradingRuntime(ir).status('root').pending, false)
})

test('admission and acceptance stay pending; partial fills and terminal exits alone settle the round trip', async () => {
  const h = await tradingHarness(strategy())
  h.bar(0); const buy = h.sent[0]
  assert.equal(h.runtime.ledger.resources().cashCents, 1000)
  assert.equal(h.runtime.ledger.resources().availableCashCents, 960)
  assert.equal(h.state().active, false); assert.equal(h.state().pending, true)
  h.receipt(buy, 'accepted', 0); h.fill(buy, 2, 1)
  h.bar(2); assert.equal(h.sent.length, 1, 'The wait-terminal policy cannot exit an incomplete entry')
  h.fill(buy, 2, 2); h.bar(3)
  const sell = h.sent[1]; assert.equal(sell.side, 'sell'); assert.equal(sell.quantity, 4)
  h.fill(sell, 1, 4); assert.equal(h.state().completedRoundTrip, false)
  h.fill(sell, 3, 5)
  assert.equal(h.state().completedRoundTrip, true); assert.equal(h.state().pending, false)
  assert.equal(h.runtime.ledger.resources().cashCents, 1000)
  h.bar(6); assert.equal(h.sent.length, 2, 'A completed strategy stays complete until reset')
})

test('owned-quantity exits can overlap entry receipts without completing while the entry is pending', async () => {
  const h = await tradingHarness(strategy(), { exitWhileEntryPending: 'owned-quantity' })
  h.bar(0); h.fill(h.sent[0], 2, 1); h.bar(2)
  assert.equal(h.sent[1].quantity, 2)
  h.fill(h.sent[1], 2, 2)
  assert.equal(h.state().active, false); assert.equal(h.state().pending, true); assert.equal(h.state().completedRoundTrip, false)
  h.fill(h.sent[0], 2, 3); h.bar(4); h.fill(h.sent[2], 2, 4)
  assert.equal(h.state().completedRoundTrip, true)
  assert.equal(h.runtime.ledger.snapshot().lots.length, 1)
})

test('zero-fill cancellation releases a RACE reservation without inventing a completed round trip', async () => {
  const h = await tradingHarness(template('race', [strategy(), strategy()]), {}, {
    dispatch(intent, receipt) { receipt(intent, 'accepted', intent.time) },
  })
  h.bar(0); assert.equal(h.sent.length, 1); assert.equal(h.state().winner, 1)
  h.receipt(h.sent[0], 'cancelled', 1)
  assert.equal(h.state().winner, null); assert.equal(h.state().completedRoundTrip, false)
  const acquired = h.runtime.snapshot().transitions.filter(row => row.kind === 'race-acquired').length
  h.receipt(h.sent[0], 'accepted', 1)
  assert.equal(h.runtime.snapshot().transitions.filter(row => row.kind === 'race-acquired').length, acquired, 'A late acceptance of a terminal ticket cannot reacquire ownership')
  h.bar(1); assert.equal(h.sent.length, 1, 'An empty reservation releases on the next bar after the receipt')
  h.bar(2); assert.equal(h.sent.length, 2)
})

test('RACE first-fill ownership cancels and liquidates losing partial inventory before release', async () => {
  const h = await tradingHarness(template('race', [strategy(), strategy()], { policy: { claim: 'first-fill', release: 'empty-or-complete-next-bar', losers: 'cancel-then-liquidate' } }))
  h.bar(0); assert.equal(h.sent.length, 2); assert.equal(h.state().winner, null)
  h.receipt(h.sent[0], 'accepted', 0); h.receipt(h.sent[1], 'accepted', 0)
  assert.equal(h.state().winner, null)
  h.fill(h.sent[1], 2, 1); h.fill(h.sent[0], 1, 1)
  assert.equal(h.state().winner, 2)
  h.bar(2); assert.deepEqual(h.cancelled, ['i1'])
  h.fill(h.sent[0], 1, 2); h.receipt(h.sent[0], 'cancelled', 3)
  h.fill(h.sent[1], 2, 3); h.bar(4)
  assert.deepEqual(h.sent.slice(2).map(row => [row.owner, row.side, row.quantity, row.reason]), [['n1', 'sell', 2, 'race-release'], ['n2', 'sell', 4, 'exit']])
  h.fill(h.sent[3], 4, 4)
  assert.equal(h.state().completedRoundTrip, false, 'Winner completion cannot orphan a pending losing exit')
  h.fill(h.sent[2], 2, 5)
  assert.equal(h.state().completedRoundTrip, true); assert.equal(h.state('root/child0').generation, 1)
  assert.deepEqual(h.runtime.ledger.snapshot().positions.map(row => row.quantity), [0, 0])
})

test('SEQUENCE hands off after a complete real round trip and strictly after its receipt timestamp', async () => {
  const h = await tradingHarness(template('sequence', [strategy(), strategy()]))
  h.bar(0); h.fill(h.sent[0], 4, 0); h.bar(1); h.fill(h.sent[1], 2, 1)
  h.bar(2); assert.equal(h.sent.length, 2); assert.equal(h.state().cursor, 0)
  h.fill(h.sent[1], 2, 3); assert.equal(h.state().cursor, 1)
  h.bar(3); assert.equal(h.sent.length, 2)
  h.bar(4); assert.equal(h.sent[2].owner, 'n2')
})

test('reset waits for cancel acknowledgments and terminal liquidation including fills received after cancellation requests', async () => {
  const h = await tradingHarness(strategy())
  h.bar(0); h.fill(h.sent[0], 1, 0); h.reset('root', 1)
  assert.equal(h.state().resetPhase, 'cancel'); assert.equal(h.state().generation, 0)
  h.bar(2); assert.deepEqual(h.cancelled, ['i1'])
  h.fill(h.sent[0], 2, 3); h.receipt(h.sent[0], 'cancelled', 3)
  h.bar(4); assert.equal(h.sent[1].quantity, 3); assert.equal(h.sent[1].reason, 'reset')
  h.fill(h.sent[1], 2, 4); h.bar(5)
  assert.equal(h.sent.length, 2); assert.equal(h.state().generation, 0)
  h.fill(h.sent[1], 1, 6)
  assert.equal(h.state().generation, 1); assert.equal(h.state().resetPhase, null)
  assert.equal(h.state().completedRoundTrip, false); assert.equal(h.state().lotId, null)
  h.bar(6); assert.equal(h.sent.length, 2)
  h.bar(7); assert.equal(h.sent.length, 3); assert.notEqual(h.sent[2].lotId, h.sent[0].lotId)
})

test('malformed frozen scopes, namespaces, rules, dependencies and undeclared policy changes fail before dispatch', async () => {
  const { ir } = await tradingCase(template('all', [strategy(), template('race', [strategy(), strategy()])]))
  for (const mutate of [
    value => { value.nodes[0].children.reverse() },
    value => { value.nodes[0].children = [1, 1] },
    value => { value.nodes[1].scopeEnd = 5 },
    value => { value.nodes[2].scopeEnd = 4 },
    value => { value.nodes[3].parent = 0 },
    value => { value.nodes[3].path = 'root/child0' },
    value => { value.nodes[4].namespace = 'n3' },
    value => { value.nodes[1].roles.buy_process.rule.cashCapCents = null },
    value => { value.nodes[1].roles.buy_reason.rule.asset = 'UNKNOWN' },
    value => { delete value.nodes[1].roles.buy_reason.rule.asset },
    value => { value.nodes[1].roles.buy_reason.requirementId = value.nodes[3].roles.buy_reason.requirementId },
    value => { value.nodes[2].policy.claim = 'internal-admission' },
    value => { value.nodes[2].gate = { kind: 'event' } },
    value => { value.nodes[0].initialState.generation = 1 },
    value => { value.historyWindows[0].observations = 2 },
    value => { value.execution.owners.reverse() },
    value => { value.contract.sameBar = 'repeat-until-flat' },
    value => { value.contract.barBudget = null },
  ]) {
    const changed = structuredClone(ir); mutate(changed)
    assert.throws(() => validateTradingIR(changed), undefined, mutate.toString())
    assert.throws(() => createTradingRuntime(changed), undefined, mutate.toString())
  }
})

const immediate = { dispatch(intent, receipt) { receipt(intent, 'fill', intent.time, { quantity: intent.quantity, priceCents: 10, feeCents: 0 }) } }
const idle = () => strategy({ buy_reason: { kind: 'above', value: 100 } })
const stateGate = close => ({ kind: 'state', predicate: { kind: 'above', asset: 'GATE', value: 5 }, close })
const eventGate = (overrides = {}) => ({ kind: 'event', predicate: { kind: 'above', asset: 'GATE', value: 5 }, close: 'block-entries',
  trigger: 'rising-edge', ttlBars: 1, rearm: 'after-false-while-closed', ...overrides })

test('a closed or unready state gate blocks new entries while existing private exits continue', async () => {
  for (const gatePrice of [1, null]) {
    const h = await tradingHarness(template('all', [strategy(), strategy()], { gate: stateGate('block-entries') }), {}, immediate)
    h.bar(0, { SPY: 10, GATE: 10 }); assert.equal(h.sent.length, 2)
    h.bar(1, { SPY: 10, GATE: gatePrice }); assert.equal(h.sent.length, 4)
    assert.equal(h.state().completedRoundTrip, true)
    assert.equal(h.state().gateOpen, gatePrice === null, 'Missing data is not a false predicate transition')
    assert.equal(h.runtime.snapshot().transitions.filter(row => row.kind === 'gate-closed').length, gatePrice === null ? 0 : 1)
  }
})

test('event gates expire at the declared boundary and missing observations cannot manufacture rearming edges', async () => {
  const h = await tradingHarness(template('all', [idle(), idle()], { gate: eventGate() }))
  h.bar(0, { SPY: 10, GATE: 10 }); assert.equal(h.state().gateOpen, true)
  h.bar(1, { SPY: 10, GATE: 10 }); assert.equal(h.state().gateOpen, false); assert.equal(h.state().gateArmed, false)
  h.bar(2, { SPY: 10 }); assert.equal(h.state().previousGate, true); assert.equal(h.state().gateArmed, false)
  h.bar(3, { SPY: 10, GATE: 10 }); assert.equal(h.state().gateOpen, false)
  h.bar(4, { SPY: 10, GATE: 1 }); assert.equal(h.state().gateArmed, true)
  h.bar(5, { SPY: 10, GATE: 10 }); assert.equal(h.state().gateOpen, true)
  assert.deepEqual(h.runtime.snapshot().transitions.filter(row => row.kind.startsWith('gate-')).map(row => [row.kind, row.time]), [
    ['gate-opened', 0], ['gate-expired', 1], ['gate-opened', 5],
  ])
})

test('event gates with reset-only rearming remain closed after false observations until a real subtree reset', async () => {
  const h = await tradingHarness(template('all', [idle(), idle()], { gate: eventGate({ rearm: 'subtree-reset' }) }))
  h.bar(0, { SPY: 10, GATE: 10 }); h.bar(1, { SPY: 10, GATE: 1 }); h.bar(2, { SPY: 10, GATE: 10 })
  assert.equal(h.state().gateOpen, false)
  h.reset('root', 3); h.bar(4, { SPY: 10, GATE: 10 })
  assert.equal(h.state().generation, 1); assert.equal(h.state().gateOpen, true)
})

test('a gate drain preserves the disarmed gate while cancellation receipts synchronously clear its descendants', async () => {
  const h = await tradingHarness(template('all', [strategy(), strategy()], { gate: eventGate({ close: 'drain-and-reset' }) }), {}, {
    dispatch(intent, receipt) { receipt(intent, 'accepted', intent.time) },
    cancel(id, receipt, runtime) { receipt(id, 'cancelled', runtime.snapshot().clock.time) },
  })
  h.bar(0, { SPY: 10, GATE: 10 }); h.bar(1, { SPY: 10, GATE: 10 })
  assert.deepEqual(h.cancelled, ['i1', 'i2']); assert.equal(h.state().generation, 1)
  assert.equal(h.state().gateArmed, false); assert.equal(h.state().gateOpen, false); assert.equal(h.sent.length, 2)
  h.bar(2, { SPY: 10, GATE: 10 }); assert.equal(h.sent.length, 2)
  h.bar(3, { SPY: 10, GATE: 1 }); h.bar(4, { SPY: 10, GATE: 10 })
  assert.equal(h.sent.length, 4)
})

test('recursive reset preserves its requesting edge latch and never reenters on the clearing bar', async () => {
  const root = template('all', [strategy(), strategy()], { reset: { predicate: { kind: 'above', asset: 'GATE', value: 5 }, trigger: 'rising-edge' } })
  const h = await tradingHarness(root, {}, immediate)
  h.bar(0, { SPY: 10, GATE: 1 }); h.bar(1, { SPY: 10, GATE: 10 })
  assert.equal(h.sent.length, 4); assert.deepEqual(h.sent.slice(2).map(row => row.reason), ['reset', 'reset'])
  assert.equal(h.state().generation, 1); assert.equal(h.state().previousReset, true)
  h.bar(2, { SPY: 10, GATE: 10 })
  assert.equal(h.sent.length, 6); assert.equal(h.state().generation, 1)
  h.bar(3, { SPY: 10, GATE: 1 }); h.bar(4, { SPY: 10, GATE: 10 })
  assert.equal(h.state().generation, 2)
})

test('subtree history restart and retained observations have distinct declared readiness after reset', async () => {
  for (const resetHistory of ['retain-observations', 'restart-subtree']) {
    const h = await tradingHarness(strategy({ buy_reason: { kind: 'above_sma', period: 3 }, buy_process: { kind: 'shares', quantity: 4, cashCapCents: 100 } }), { resetHistory })
    for (let time = 0; time < 3; time++) h.bar(time)
    assert.equal(h.state().readiness.entry, true); assert.equal(h.sent.length, 0)
    h.reset('root', 3); h.bar(4, { SPY: 11 })
    assert.equal(h.state().readiness.entry, resetHistory === 'retain-observations')
    assert.equal(h.sent.length, resetHistory === 'retain-observations' ? 1 : 0)
    if (resetHistory === 'restart-subtree') {
      h.bar(5, { SPY: 12 }); assert.equal(h.sent.length, 0)
      h.bar(6, { SPY: 13 }); assert.equal(h.sent.length, 1)
    }
  }
})

test('declared child order resolves shared cash and callbacks observe admitted pending state', async () => {
  const observations = []
  const h = await tradingHarness(template('all', [strategy(), strategy()]), { cashCents: 60 }, {
    dispatch(intent, receipt, runtime) { observations.push(runtime.status('root')); receipt(intent, 'accepted', intent.time) },
  })
  h.bar(0)
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].owner, 'n1'); assert.equal(observations[0].pending, true)
  assert.equal(h.runtime.ledger.snapshot().decisions[1].reason, 'insufficient-unreserved-cash')
  assert.equal(h.runtime.ledger.admit, undefined, 'Caller cannot bypass the runtime controller with direct ledger mutations')
  h.receipt(h.sent[0], 'cancelled', 1); h.bar(2)
  assert.equal(h.sent[1].owner, 'n1', 'The declared order is also the deterministic retry order')
})

test('bars and receipts obey one chronology and repeated observations neither dispatch nor inflate coverage', async () => {
  const h = await tradingHarness(strategy(), { limits: { intents: 5, events: 10, bars: 2 } })
  h.bar(0); const event = h.receipt(h.sent[0], 'accepted', 1)
  assert.throws(() => h.bar(0), /chronology/)
  assert.throws(() => h.receipt(h.sent[0], 'fill', 0, { quantity: 1, priceCents: 10, feeCents: 0 }), /timestamp/)
  const before = h.runtime.snapshot()
  h.runtime.status('root'); h.runtime.snapshot(); h.runtime.reconcile(event)
  assert.deepEqual(h.runtime.snapshot(), before)
  h.bar(1)
  const full = h.runtime.snapshot()
  assert.throws(() => h.bar(2), /completed-bar budget/)
  assert.deepEqual(h.runtime.snapshot(), full)
})

test('mixed recursive trees through nine template levels use the ordinary lifecycle with no depth-specific runtime path', async () => {
  let root = strategy()
  for (let level = 0; level < 9; level++) {
    const operator = ['sequence', 'all', 'race'][level % 3], count = 2 + level % 3
    root = template(operator, [root, ...Array.from({ length: count - 1 }, () => strategy())])
  }
  const h = await tradingHarness(root, { cashCents: 100000 }, immediate)
  for (let time = 0; time < 120 && !h.state().completedRoundTrip; time++) h.bar(time)
  assert.equal(h.state().completedRoundTrip, true)
  assert.equal(h.state().active, false); assert.equal(h.state().pending, false)
  assert.ok(h.ir.nodes.some(row => row.path.split('/').length === 10))
  assert.ok(h.runtime.snapshot().transitions.some(row => row.kind === 'sequence-advanced'))
  assert.ok(h.runtime.snapshot().transitions.some(row => row.kind === 'race-released'))
})

test('every operator arity completes with the declared order and both RACE acquisition policies', async () => {
  for (const operator of ['all', 'sequence', 'race']) for (const count of [2, 3, 4]) for (const claim of operator === 'race' ? ['broker-accepted', 'first-fill'] : [null]) {
    const root = template(operator, Array.from({ length: count }, () => strategy()))
    if (claim) root.policy.claim = claim
    const h = await tradingHarness(root, {}, immediate)
    for (let time = 0; time < 20 && !h.state().completedRoundTrip; time++) h.bar(time)
    assert.equal(h.state().completedRoundTrip, true, [operator, count, claim].join('/'))
    const entries = h.sent.filter(row => row.side === 'buy').map(row => row.owner)
    assert.deepEqual(entries, Array.from({ length: operator === 'race' ? 1 : count }, (_, index) => 'n' + (index + 1)))
    assert.equal(h.runtime.ledger.resources().cashCents, 1000)
  }
})

test('a scoped child reset invalidates ancestor completion and rewinds only the affected sequence branch', async () => {
  for (const operator of ['all', 'sequence', 'race']) {
    const h = await tradingHarness(template(operator, [strategy(), strategy()]), {}, immediate)
    for (let time = 0; time < 10 && !h.state().completedRoundTrip; time++) h.bar(time)
    assert.equal(h.state().completedRoundTrip, true)
    const sibling = h.state('root/child1'), count = h.sent.length
    h.reset('root/child0', 10)
    assert.equal(h.state().completedRoundTrip, false)
    assert.equal(h.state('root/child1').generation, sibling.generation)
    assert.equal(h.state('root/child1').completedRoundTrip, sibling.completedRoundTrip)
    if (operator === 'sequence') assert.equal(h.state().cursor, 0)
    h.bar(11); h.bar(12)
    assert.equal(h.sent.length, count + 2); assert.equal(h.state().completedRoundTrip, true)
  }
})

test('resetting an occupied winning subtree drains it and releases RACE without claiming a completed episode', async () => {
  const h = await tradingHarness(template('race', [strategy(), strategy()]), {}, immediate)
  h.bar(0); assert.equal(h.state().winner, 1)
  h.reset('root/child0', 1); h.bar(2)
  assert.equal(h.sent.length, 2); assert.equal(h.state().winner, null); assert.equal(h.state().completedRoundTrip, false)
  h.bar(3); assert.equal(h.sent.length, 3); assert.equal(h.state().winner, 1)
})

test('independent Python and JavaScript controllers agree on fixed seeded partial-fill, cancellation, gate and recursive-reset histories', async () => {
  const cases = [], expectations = []
  for (let seed = 1; seed <= 32; seed++) {
    let word = seed
    const random = maximum => { word = (Math.imul(word, 1664525) + 1013904223) >>> 0; return word % maximum }
    const leaf = () => strategy({ sell_reason: { kind: 'after', bars: 1 + random(3) },
      sell_process: random(2) ? { kind: 'all' } : { kind: 'fraction', basisPoints: 5000 } })
    let root = leaf()
    for (let depth = 0; depth < 2 + seed % 4; depth++) {
      const operator = ['all', 'race', 'sequence'][random(3)]
      root = template(operator, [root, ...Array.from({ length: 1 + random(3) }, leaf)], {
        gate: depth % 3 === 0 ? stateGate(seed % 2 ? 'block-entries' : 'drain-and-reset') : depth % 3 === 1 ? eventGate({ ttlBars: 3 + random(4) }) : { kind: 'none' },
        reset: depth % 2 ? { predicate: { kind: 'below', asset: 'GATE', value: 3 }, trigger: 'rising-edge' } : null,
      })
      if (operator === 'race') root.policy.claim = seed % 2 ? 'first-fill' : 'broker-accepted'
    }
    const h = await tradingHarness(root, { cashCents: 80 + seed % 5 * 40,
      exitWhileEntryPending: seed % 2 ? 'owned-quantity' : 'wait-terminal', resetHistory: seed % 3 ? 'retain-observations' : 'restart-subtree' }, {
      dispatch(intent, receipt) {
        if (random(3) === 0) receipt(intent, 'fill', intent.time, { quantity: Math.max(1, Math.floor(intent.quantity / 2)), priceCents: 10, feeCents: 0 })
        else if (random(2)) receipt(intent, 'accepted', intent.time)
      },
      cancel(id, receipt, runtime) { if (random(2)) receipt(id, 'cancelled', runtime.snapshot().clock.time) },
    })
    for (let bar = 0; bar < 60; bar++) {
      const time = bar * 3
      for (const prior of h.runtime.ledger.snapshot().tickets) {
        const ticket = h.runtime.ledger.ticket(prior.id)
        if (['filled', 'cancelled', 'expired', 'rejected'].includes(ticket.status)) continue
        const decision = random(5)
        if (decision === 0) h.receipt(ticket, ticket.cancellationRequested ? 'cancelled' : 'expired', time)
        else if (decision <= 2) h.fill(ticket, 1 + random(ticket.quantity - ticket.filledQuantity), time)
      }
      if ([20, 40].includes(bar)) h.reset('root', time)
      h.bar(time + 1, { SPY: 10, GATE: bar % 11 === 0 ? null : bar % 7 < 4 ? 10 : 1 })
      const snapshot = h.runtime.snapshot()
      assert.ok(snapshot.ledger.lots.every(lot => lot.quantity >= lot.reservedQuantity && lot.quantity === lot.boughtQuantity - lot.soldQuantity))
      assert.ok(snapshot.ledger.cashCents >= snapshot.ledger.reservedCashCents)
      assert.equal(snapshot.ledger.cashCents, h.config.cashCents - snapshot.ledger.positions.reduce((sum, row) => sum + row.quantity * 10, 0))
      for (const node of snapshot.states) if (node.completedRoundTrip) assert.equal(node.active || node.pending, false, 'Completion cannot conceal actual descendants')
    }
    cases.push({ ir: h.ir, actions: h.actions })
    expectations.push({ sent: h.sent, cancelled: h.cancelled, snapshot: h.runtime.snapshot(), checkpoints: [] })
  }
  const result = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-B', fileURLToPath(new URL('../../src/benchmark/trading_reference.py', import.meta.url))], {
    input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const actual = JSON.parse(result.stdout)
  for (const [index, expected] of expectations.entries()) assert.deepEqual(actual[index], expected, 'Independent lifecycle mismatch for fixed seed ' + (index + 1))
})
