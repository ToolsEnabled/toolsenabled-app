import { PYTHON_COMMAND, PYTHON_ARGS } from './lib/python-command.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { canonical, compilePrompt } from '../../src/benchmark/prompts.mjs'
import { generateLeanTasks, interpretLean, leanCatalog, leanStarter, strategyRef } from '../../src/benchmark/lean.mjs'
import { generateLeanProgram } from '../../src/benchmark/lean-codegen.mjs'
import { normalizeOrderEvents } from '../../src/benchmark/lean-grade.mjs'

const python = fileURLToPath(new URL('../../src/benchmark/lean-reference.py', import.meta.url))
// Reference imports must not write __pycache__ into the source being measured.
async function check(root, input = leanStarter().tasks[0].input) {
  const compiled = await compilePrompt(leanCatalog(), root), expected = interpretLean(compiled.semantic, input)
  const result = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-B', python], { input: JSON.stringify({ semantic: compiled.semantic, input }), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), expected)
  return { compiled, expected }
}
const leaf = () => strategyRef()
const wrap = child => ({ use: 'constitution-v1', slots: { strategy: child } })
const bars = prices => prices.map((price, i) => ({ time: `2024-01-02T14:${String(30 + i).padStart(2, '0')}:00Z`, prices: { SPY: price } }))

test('four-role compiler matches hand-specified trace, Python interpretation and valid generated LEAN source', async () => {
  const task = leanStarter().tasks[0], { expected, compiled } = await check(task.root, task.input)
  assert.deepEqual(expected.trace, task.expected); assert.equal(expected.cashCents, 1001400); assert.deepEqual(expected.lots, {})
  for (const role of ['Buy reason', 'Buy process', 'Sell reason', 'Sell process']) assert.ok(compiled.text.includes(role))
  const source = generateLeanProgram({ ...task, compiled })
  const parsed = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source, encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr); assert.match(source, /on_order_event/)
})
test('the Python decision kernel reserves an intention without predicting cash, holdings or a filled tape', async () => {
  const task = leanStarter().tasks[0], compiled = await compilePrompt(leanCatalog(), task.root)
  const script = [
    'import json,runpy,sys',
    'from pathlib import Path',
    'sys.path.insert(0,str(Path(sys.argv[1]).parent))',
    'Reference=runpy.run_path(sys.argv[1])["Reference"]',
    'task=json.load(sys.stdin)',
    'observed=[]',
    'def dispatch(intent):',
    ' before=reference.ledger.snapshot()',
    ' observed.append(dict(cash=reference.cash,qty=reference.nodes[intent["owner"]].quantity,tape=list(reference.tape),pending=reference.ledger.status([intent["owner"]])["pending"],reserved=before["reservedCashCents"]))',
    ' if mode=="partial":',
    '  reference.reconcile(dict(id="native-fill",intentId=intent["id"],brokerOrderId="native-1",kind="fill",time=0,quantity=1,priceCents=10000,feeCents=0))',
    'results=[]',
    'for mode in ["pending","partial"]:',
    ' reference=Reference(task["semantic"],task["input"]["cashCents"],dispatch=dispatch)',
    ' try: reference.step(task["input"]["bars"][0]["prices"]); raise AssertionError("v1 silently accepted incomplete execution")',
    ' except ValueError as error: assert "synchronous full fill" in str(error)',
    ' results.append(dict(cash=reference.cash,trace=reference.tape,lots=reference.result()["lots"],pending=reference.ledger.status(list(reference.nodes))["pending"]))',
    'print(json.dumps(dict(observed=observed,results=results)))',
  ].join('\n')
  const run = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-B', '-c', script, python], { input: canonical({ semantic: compiled.semantic, input: task.input }), encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const { observed, results } = JSON.parse(run.stdout)
  assert.deepEqual(observed, Array(2).fill({ cash: 1000000, qty: 0, tape: [], pending: true, reserved: 20000 }))
  assert.deepEqual(results[0], { cash: 1000000, trace: [], lots: {}, pending: true })
  assert.equal(results[1].cash, 990000); assert.deepEqual(results[1].lots, { 'root/strategy': 1 })
  assert.equal(results[1].trace.length, 1); assert.equal(results[1].trace[0].quantity, 1); assert.equal(results[1].pending, true)
})
test('parallel shared-symbol strategies retain private lots and resolve cash contention by declared order', async () => {
  const tree = wrap({ use: 'parallel', slots: { first: leaf(), second: leaf() } })
  const { expected } = await check(tree)
  assert.deepEqual(expected.trace.map(fill => fill.quantity), [2, 2, -2, -2]); assert.notEqual(expected.trace[0].path, expected.trace[1].path)
  const { expected: constrained } = await check(tree, { ...leanStarter().tasks[0].input, cashCents: 20000 })
  assert.deepEqual(constrained.trace.map(fill => fill.bar), [0, 2, 3, 4])
})
test('sequence delays its handoff by one bar; race can grant ownership to a nested template', async () => {
  const sequence = { use: 'sequence', slots: { first: leaf(), second: leaf() } }
  assert.deepEqual((await check(wrap(sequence))).expected.trace.map(fill => fill.bar), [0, 2, 3, 4])
  const { expected } = await check(wrap({ use: 'race', slots: { first: sequence, second: leaf() } }))
  assert.ok(expected.trace.every(fill => fill.path.includes('/first/'))); assert.deepEqual(expected.trace.map(fill => fill.bar), [0, 2, 3, 4])
})
test('mixed templates execute through seven nested levels using both implementations', async () => {
  let tree = leaf()
  for (let depth = 0; depth < 7; depth++) tree = { use: ['parallel', 'sequence', 'race'][depth % 3], slots: { first: tree, second: leaf() } }
  const { expected, compiled } = await check(wrap(tree))
  assert.ok(compiled.depth >= 8); assert.ok(expected.trace.length >= 2); assert.ok(expected.trace.some(fill => fill.path.split('/').length >= 9))
})
test('gates continue exits, events latch, and reset liquidates private lots before later reactivation', async () => {
  for (const use of ['state-gate', 'event-gate']) assert.deepEqual((await check(wrap({ use, params: { threshold: 9900, symbol: 'SPY' }, slots: { child: leaf() } }))).expected.trace.map(fill => fill.bar), [0, 2])
  const input = { cashCents: 100000, bars: bars([10000, 8500, 10000, 10800]) }
  const { expected } = await check(wrap({ use: 'reset', slots: { child: leaf() } }), input)
  assert.deepEqual(expected.trace.map(fill => [fill.bar, fill.quantity, fill.reason]), [[0, 2, 'buy'], [1, -2, 'reset'], [2, 2, 'buy'], [3, -2, 'sell']])
})
test('partial exits, cash sizing, missing bars, crossings and SMA readiness agree', async () => {
  const input = { cashCents: 100000, bars: bars([10000, 9900, null, 10100, 10700, 10800, 10900]) }
  for (const buy of ['cross-up', 'above-average', 'below-price']) for (const process of ['fixed-shares', 'cash-fraction']) {
    const { expected } = await check(wrap(strategyRef({ buy_reason: buy, buy_process: process, sell_process: 'sell-fraction' })), input)
    assert.ok(expected.trace.length > 0); assert.ok(expected.trace.every(fill => fill.bar !== 2))
  }
})
test('fixed trace rejects changed sizing and wrong exit logic', async () => {
  const expected = leanStarter().tasks[0].expected, wrong = leaf(); wrong.slots.buy_process.params = { quantity: 3 }
  assert.notDeepEqual((await check(wrap(wrong))).expected.trace, expected)
  wrong.slots.sell_reason.params = { threshold: 50000 }
  assert.equal((await check(wrap(wrong))).expected.trace.length, 1)
})
test('four role choices generate a real Cartesian set of distinct recursive prompts', async () => {
  const choices = { buy_reason: ['below-price', 'cross-up'], buy_process: ['fixed-shares', 'cash-fraction'], sell_reason: ['exit-above', 'holding-period'], sell_process: ['sell-all', 'sell-fraction'] }
  const tasks = generateLeanTasks(choices, { wrapper: 'race', input: leanStarter().tasks[0].input })
  assert.equal(tasks.length, 16)
  const prompts = await Promise.all(tasks.map(task => compilePrompt(leanCatalog(), task.root)))
  assert.equal(new Set(prompts.map(prompt => prompt.promptSha256)).size, 16)
  assert.ok(prompts.every(prompt => prompt.semantic.children.strategy.kind === 'race'))
})

test('integer cents remain exact at safe input limits for SMA, sizing, partial exits and unaffordable orders', async () => {
  const cashCents = Number.MAX_SAFE_INTEGER
  const partial = strategyRef({ buy_process: 'cash-fraction', sell_reason: 'holding-period', sell_process: 'sell-fraction' })
  partial.slots.buy_reason.params = { threshold: 2 }
  partial.slots.buy_process.params = { basisPoints: 10000 }
  partial.slots.sell_reason.params = { bars: 1 }
  partial.slots.sell_process.params = { basisPoints: 232 }
  const sized = (await check(wrap(partial), { cashCents, bars: bars([1, 1]) })).expected
  assert.deepEqual(sized.trace.map(fill => fill.quantity), [cashCents, -208967022709990])
  assert.equal(sized.cashCents, 208967022709990)

  const average = strategyRef({ buy_reason: 'above-average' })
  average.slots.buy_reason.params = { period: 2 }
  average.slots.buy_process.params = { quantity: 1 }
  const sma = (await check(wrap(average), { cashCents, bars: bars([cashCents - 2, cashCents - 1]) })).expected
  assert.deepEqual(sma.trace.map(fill => [fill.bar, fill.quantity]), [[1, 1]])
  assert.equal(sma.cashCents, 1)

  const expensive = strategyRef({ buy_reason: 'above-price' })
  expensive.slots.buy_reason.params = { threshold: 1 }
  assert.deepEqual((await check(wrap(expensive), { cashCents, bars: bars([cashCents]) })).expected.trace, [])
})

test('explicit child order survives canonical JSON through parallel cash contention and nested race ownership', async () => {
  const catalog = leanCatalog()
  for (const kind of ['parallel', 'race']) catalog.find(bundle => bundle.id === kind).slotOrder = ['second', 'first']
  for (const kind of ['parallel', 'race']) {
    const root = wrap({ use: kind, slots: { first: leaf(), second: { use: 'sequence', slots: { first: leaf(), second: leaf() } } } })
    const compiled = await compilePrompt(catalog, root), input = { ...leanStarter().tasks[0].input, cashCents: 20000 }
    const expected = interpretLean(compiled.semantic, input)
    const decoded = JSON.parse(canonical(compiled.semantic))
    assert.deepEqual(interpretLean(decoded, input), expected)
    const result = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-B', python], { input: canonical({ semantic: decoded, input }), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), expected)
    assert.match(expected.trace[0].path, /\/second\/first$/)
    if (kind === 'race') assert.ok(expected.trace.every(fill => fill.path.includes('/strategy/second/')))
  }
})

test('Lean input and gate ticker names cannot become arbitrary data paths', async () => {
  const compiled = await compilePrompt(leanCatalog(), wrap(leaf()))
  const input = leanStarter().tasks[0].input
  input.bars[0].prices['../invalid'] = 100
  assert.throws(() => interpretLean(compiled.semantic, input), /ticker symbols/)
  const gated = await compilePrompt(leanCatalog(), wrap({ use: 'state-gate', params: { symbol: '../invalid' }, slots: { child: leaf() } }))
  assert.throws(() => interpretLean(gated.semantic, leanStarter().tasks[0].input), /ticker symbol/)
})

test('native LEAN serialization uses symbolValue and filled enum 3, with exact full market fills', async () => {
  const starter = leanStarter().tasks[0], task = { ...starter, compiled: await compilePrompt(leanCatalog(), starter.root) }
  const orders = { 1: { type: 0, quantity: 2, tag: 'root/strategy|buy' }, 2: { type: 0, quantity: -2, tag: 'root/strategy|sell' } }
  const events = [
    { orderId: 1, symbol: 'SPY RR0YMZ7APC9X', symbolValue: 'SPY', time: 1704205860, status: 'filled', fillQuantity: 2, fillPrice: 100, orderFeeAmount: 0, fillPriceCurrency: 'USD' },
    { orderId: 2, symbol: 'SPY RR0YMZ7APC9X', symbolValue: 'SPY', time: 1704205980, status: 3, fillQuantity: -2, fillPrice: 107, orderFeeAmount: 0, fillPriceCurrency: 'USD' },
  ]
  assert.deepEqual(normalizeOrderEvents(events, orders, task), starter.expected)
  const changed = (key, value) => [{ ...events[0], [key]: value }]
  assert.throws(() => normalizeOrderEvents(changed('status', 2), orders, task), /Partial fills/)
  assert.throws(() => normalizeOrderEvents(changed('fillPrice', 100.000000001), orders, task), /sub-cent/)
  assert.throws(() => normalizeOrderEvents(changed('fillQuantity', 1), orders, task), /whole order/)
  assert.throws(() => normalizeOrderEvents(changed('symbolValue', 'QQQ'), orders, task), /wrong strategy symbol/)
  assert.throws(() => normalizeOrderEvents(changed('orderFeeAmount', 0.01), orders, task), /zero order fees/)
  assert.throws(() => normalizeOrderEvents(events, { ...orders, 1: { ...orders[1], type: 1 } }, task), /native market orders/)
})
