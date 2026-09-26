// Source generation and trusted-reference qualification for the operational IR.
// Native candidate grading must use retained engine artifacts, not this
// reference program's diagnostic controller snapshot.
import { canonical, invariant, object } from './prompts.mjs'
import { validateTradingIR } from './trading-ir.mjs'
import { createTradingRuntime } from './trading-runtime.mjs'
import { verifyNativeExecution } from './execution-lean.mjs'

export function generateOperationalLeanProgram(ir, bars, sources, { observationTags = false } = {}) {
  validateTradingIR(ir)
  invariant(ir.execution.currency === 'USD' && ir.execution.assets.every(asset => /^[A-Z][A-Z0-9.]{0,15}$/.test(asset.id) && asset.multiplier === 1 && asset.quantityStep === 1),
    'This native adapter requires explicit USD equity assets with unit multipliers and quantity steps.')
  invariant(Array.isArray(bars) && bars.length > 0 && bars.length <= ir.contract.barBudget, 'Declare the complete bounded native bar input.')
  const assets = new Set(ir.execution.assets.map(asset => asset.id))
  let previous = -1
  for (const bar of bars) {
    invariant(object(bar) && Object.keys(bar).every(key => ['time', 'prices'].includes(key)) && Number.isSafeInteger(bar.time) && bar.time >= 0 && bar.time % 60 === 0
      && bar.time > previous && bar.time <= 4102444800 && object(bar.prices), 'Native inputs need ordered minute-aligned UTC seconds.')
    invariant(Object.entries(bar.prices).every(([asset, price]) => assets.has(asset) && (price === null || Number.isSafeInteger(price) && price > 0))
      && Object.values(bar.prices).some(price => price !== null), 'A native completed bar needs observed declared prices.')
    previous = bar.time
  }
  const template = sources['trading_lean.py']
  invariant(typeof template === 'string' && template.split('TASK = None').length === 2, 'Pin the native operational adapter source.')
  return template.replace('TASK = None', () => 'TASK = json.loads(' + JSON.stringify(canonical({ ir, bars, ...(observationTags ? { observationTags: true } : {}) })) + ')')
}

export function inlineOperationalLeanProgram(program, sources) {
  const modules = ['execution_reference', 'trading_reference', 'execution_lean']
  const lines = ['# Self-contained frozen operational apparatus.', 'import sys as _lb_sys, types as _lb_types']
  for (const name of modules) {
    invariant(typeof sources[name + '.py'] === 'string', 'Pin every independent Python module before inlining.')
    lines.push('_lb_module = _lb_types.ModuleType(' + JSON.stringify(name) + ')',
      '_lb_sys.modules[' + JSON.stringify(name) + '] = _lb_module',
      'exec(compile(' + JSON.stringify(sources[name + '.py']) + ', ' + JSON.stringify('<frozen/' + name + '.py>') + ', \"exec\"), _lb_module.__dict__)')
  }
  return lines.join('\n') + '\n' + program
}

export function replayTradingHistory(ir, actions) {
  const sent = [], cancelled = []
  let pending = [], runtime
  const callback = (kind, intentId) => {
    const action = pending.shift()
    invariant(action?.kind === kind && action.intentId === intentId, 'Operational callback order differs from retained history.')
    for (const event of action.events) runtime.reconcile(event)
  }
  runtime = createTradingRuntime(ir, {
    dispatch(intent) { sent.push(intent); callback('dispatch', intent.id) },
    cancel(intentId) { cancelled.push(intentId); callback('cancel', intentId) },
  })
  for (const action of actions) {
    if (action.kind === 'bar') {
      pending = [...action.callbacks]; runtime.step(action.bar)
      invariant(pending.length === 0, 'Retained operational callbacks were not consumed.')
    } else if (action.kind === 'receipt') runtime.reconcile(action.event)
    else if (action.kind === 'reset') runtime.requestReset(action.path, action.time)
    else invariant(false, 'Unknown operational history action.')
  }
  return { sent, cancelled, snapshot: runtime.snapshot() }
}

export function verifyNativeTradingReference({ ir, bars, result, events, snapshot }) {
  validateTradingIR(ir)
  // Authenticate the complete private book against engine orders/events before
  // using trusted-reference timing diagnostics to replay its controller.
  const journal = snapshot.ledger.journal
  const declared = journal.filter(row => row.kind !== 'broker-event').map(row => row.kind === 'intent'
    ? { kind: 'intent', intent: row.decision.intent } : { kind: 'cancel', intentId: row.event.intentId, time: row.event.time })
  const verified = verifyNativeExecution({ config: ir.execution, result, events, journal, actions: declared })
  invariant(canonical(verified) === canonical(snapshot.ledger), 'Native reference private book differs from actual receipts.')
  const receipts = new Map(journal.filter(row => row.kind === 'broker-event').map(row => {
    const { sequence, ...event } = row.event
    return [event.id, event]
  }))
  const actions = [], seen = new Set()
  let active = null, call = null, barIndex = 0
  for (const row of snapshot.timeline) {
    if (row.kind === 'bar-start') {
      invariant(!active && row.bar === barIndex && bars[barIndex]?.time === row.time, 'Native reference bar timeline differs from frozen input.')
      active = { kind: 'bar', bar: bars[barIndex++], callbacks: [] }; actions.push(active)
    } else if (row.kind === 'bar-end') {
      invariant(active && !call && row.bar === barIndex - 1 && row.time === active.bar.time, 'Native reference bar scope differs.')
      active = null
    } else if (['dispatch-start', 'cancel-start'].includes(row.kind)) {
      invariant(active && !call && row.time === active.bar.time, 'Native callback escaped its completed bar.')
      call = { kind: row.kind.split('-')[0], intentId: row.intentId, events: [] }; active.callbacks.push(call)
    } else if (['dispatch-end', 'cancel-end'].includes(row.kind)) {
      invariant(call && row.kind === call.kind + '-end' && row.intentId === call.intentId && row.time === active.bar.time, 'Native callback scope changed.')
      call = null
    } else {
      invariant(row.kind === 'receipt' && receipts.has(row.id) && !seen.has(row.id) && receipts.get(row.id).time === row.time, 'Native reference timeline changed its receipt history.')
      seen.add(row.id)
      if (call) call.events.push(receipts.get(row.id))
      else { invariant(!active, 'A reference receipt has no dispatch scope.'); actions.push({ kind: 'receipt', event: receipts.get(row.id) }) }
    }
  }
  invariant(!active && !call && barIndex === bars.length && seen.size === receipts.size, 'Native reference timeline is incomplete.')
  const replay = replayTradingHistory(ir, actions)
  invariant(canonical(replay.snapshot) === canonical(snapshot), 'Independent controller differs from actual native reference lifecycle.')
  return { actions, ...replay }
}
