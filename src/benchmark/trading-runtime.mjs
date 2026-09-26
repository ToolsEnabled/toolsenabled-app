// Operational Strategy/Template lifecycle. The caller dispatches one typed
// intention at a time and supplies broker receipts. Evaluation never invents
// a fill. This is one consumer of the normalized trading IR.
import { canonical, invariant, object } from './prompts.mjs'
import { createExecutionLedger, TICKET_TERMINAL } from './execution.mjs'
import { validateTradingIR } from './trading-ir.mjs'

const copy = value => JSON.parse(canonical(value))
const terminal = ticket => TICKET_TERMINAL.includes(ticket.status)
const integer = value => Number.isSafeInteger(value) && value >= 0

export function createTradingRuntime(sourceIR, { dispatch = () => {}, cancel = () => {} } = {}) {
  validateTradingIR(sourceIR)
  invariant(typeof dispatch === 'function' && typeof cancel === 'function', 'Trading execution needs dispatch and cancellation functions.')
  const ir = copy(sourceIR), nodes = ir.nodes, states = nodes.map(node => copy(node.initialState)), ledger = createExecutionLedger(ir.execution)
  const byPath = new Map(nodes.map((node, index) => [node.path, index])), assets = new Map(ir.execution.assets.map(asset => [asset.id, asset]))
  const history = new Map(), windows = new Map(ir.historyWindows.map(row => [row.asset, row.observations])), transitions = [], coverage = new Map()
  let prices = {}, time = -1, lastBarTime = -1, barIndex = -1, serial = 0, stepping = false
  const flags = nodes.map(() => ({ active: false, pending: false }))
  const state = index => states[index]
  const lot = index => state(index).lotId ? ledger.lot(state(index).lotId) : null
  const scopeOwners = index => nodes.slice(index, nodes[index].scopeEnd).filter(node => node.kind === 'strategy').map(node => node.namespace)
  const mark = (index, kind, detail = {}) => {
    invariant(transitions.length < ir.contract.controllerEventBudget, 'The declared controller event budget is exhausted.')
    transitions.push({ sequence: transitions.length + 1, time, path: nodes[index].path, requirementId: nodes[index].requirementId, kind, ...copy(detail) })
  }
  const observe = (requirementId, result, action = false) => {
    const count = coverage.get(requirementId) || { evaluated: 0, ready: 0, true: 0, actions: 0 }
    if (action) count.actions++
    else { count.evaluated++; if (result.ready) count.ready++; if (result.ready && result.value) count.true++ }
    coverage.set(requirementId, count)
  }
  const eligibleTime = index => state(index).blockedThrough === null || time > state(index).blockedThrough
  const readyPrice = asset => Number.isSafeInteger(prices[asset]) && prices[asset] > 0
  const evaluate = (rule, index) => {
    if (rule.kind === 'after') return { ready: state(index).firstFillTime !== null, value: state(index).firstFillTime !== null && state(index).holdingBars >= rule.bars }
    if (rule.kind === 'and' || rule.kind === 'or') {
      const clauses = rule.clauses.map(clause => evaluate(clause, index)), ready = clauses.every(clause => clause.ready)
      return { ready, value: ready && (rule.kind === 'and' ? clauses.every(clause => clause.value) : clauses.some(clause => clause.value)) }
    }
    if (!readyPrice(rule.asset)) return { ready: false, value: false }
    const values = (history.get(rule.asset) || []).filter(row => state(index).historyAfterTime === null || row.time > state(index).historyAfterTime).map(row => row.price)
    const price = prices[rule.asset], period = rule.period || (rule.kind.startsWith('cross_') ? 2 : 1)
    if (values.length < period) return { ready: false, value: false }
    let value
    if (rule.kind === 'above') value = price > rule.value
    else if (rule.kind === 'below') value = price < rule.value
    else if (rule.kind === 'cross_up') value = values.at(-2) <= rule.value && price > rule.value
    else if (rule.kind === 'cross_down') value = values.at(-2) >= rule.value && price < rule.value
    else {
      invariant(['above_sma', 'below_sma'].includes(rule.kind), 'Unknown runtime predicate.')
      const total = values.slice(-period).reduce((sum, item) => sum + BigInt(item), 0n), scaled = BigInt(price) * BigInt(period)
      value = rule.kind === 'above_sma' ? scaled > total : scaled < total
    }
    return { ready: true, value }
  }
  const sizing = index => {
    const node = nodes[index], rule = node.roles.buy_process.rule, asset = assets.get(node.asset)
    if (!readyPrice(node.asset)) return { quantity: 0, cashCapCents: 0 }
    const resources = ledger.resources(), price = BigInt(prices[node.asset]) * BigInt(asset.multiplier), step = BigInt(asset.quantityStep)
    if (rule.kind === 'shares') return { quantity: BigInt(rule.quantity) * price <= BigInt(rule.cashCapCents) ? rule.quantity : 0, cashCapCents: rule.cashCapCents }
    const budget = rule.kind === 'cash_fraction' ? Number(BigInt(resources.availableCashCents) * BigInt(rule.basisPoints) / 10000n) : rule.cashCents
    const quantity = budget > rule.feeAllowanceCents ? Number((BigInt(budget - rule.feeAllowanceCents) / price / step) * step) : 0
    return { quantity, cashCapCents: budget }
  }
  const updateFlags = () => {
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node.kind === 'strategy') { const observed = ledger.status([node.namespace]); flags[index] = { active: observed.active, pending: observed.pending } }
      else flags[index] = { active: node.children.some(child => flags[child].active), pending: node.children.some(child => flags[child].pending) }
    }
  }
  const branchFor = (parent, index) => nodes[parent].children.find(child => index >= child && index < nodes[child].scopeEnd)
  const ancestorAllows = index => {
    let child = index
    for (let parent = nodes[index].parent; parent !== null; child = parent, parent = nodes[parent].parent) {
      const node = nodes[parent], s = state(parent)
      if (s.completed || s.drain || !eligibleTime(parent) || node.gate.kind !== 'none' && (!s.gateOpen || !evaluate(node.gate.predicate, parent).ready)) return false
      if (node.operator === 'sequence' && node.children[s.cursor] !== child) return false
      if (node.operator === 'race' && s.winner !== null && s.winner !== child) return false
    }
    return true
  }
  const readiness = index => {
    const node = nodes[index], s = state(index)
    if (node.kind === 'strategy') return { entry: readyPrice(node.asset) && evaluate(node.roles.buy_reason.rule, index).ready,
      exit: readyPrice(node.asset) && evaluate(node.roles.sell_reason.rule, index).ready }
    const children = node.operator === 'sequence' ? node.children.slice(s.cursor, s.cursor + 1) : node.operator === 'race' && s.winner !== null ? [s.winner] : node.children
    const results = children.map(child => readiness(child))
    return { entry: (node.gate.kind === 'none' || evaluate(node.gate.predicate, index).ready) && results.some(child => child.entry), exit: results.some(child => child.exit) }
  }
  const canInitiate = index => {
    const node = nodes[index], s = state(index)
    if (s.completed || s.drain || !eligibleTime(index) || !ancestorAllows(index)) return false
    if (node.kind === 'strategy') {
      if (flags[index].active || flags[index].pending || s.lastActionTime === time) return false
      const condition = evaluate(node.roles.buy_reason.rule, index), size = sizing(index)
      return condition.ready && condition.value && size.quantity > 0 && size.cashCapCents <= ledger.resources().availableCashCents
    }
    if (node.gate.kind !== 'none' && (!s.gateOpen || !evaluate(node.gate.predicate, index).ready)) return false
    const children = node.operator === 'sequence' ? node.children.slice(s.cursor, s.cursor + 1) : node.operator === 'race' && s.winner !== null ? [s.winner] : node.children
    return children.some(child => canInitiate(child))
  }
  const issued = new Map(), receipts = new Map(), timeline = []
  const clearSubtree = index => {
    invariant(ledger.status(scopeOwners(index)).resettable, 'Cannot clear private inventory or pending descendants.')
    const previous = state(index), drain = copy(previous.drain)
    for (let child = index; child < nodes[index].scopeEnd; child++) {
      const old = state(child), fresh = copy(nodes[child].initialState)
      fresh.generation = old.generation + 1; fresh.blockedThrough = time
      fresh.historyAfterTime = ir.contract.resetHistory === 'restart-subtree' ? time : old.historyAfterTime
      states[child] = fresh
    }
    state(index).previousReset = previous.previousReset
    if (drain.keepGate) for (const key of ['gateOpen', 'gateOpenedBar', 'gateArmed', 'previousGate']) state(index)[key] = previous[key]
    mark(index, 'subtree-cleared', { cause: drain.cause, generation: state(index).generation, scopeEnd: nodes[index].scopeEnd })
    const parent = nodes[index].parent
    if (parent !== null && nodes[parent].operator === 'race' && state(parent).winner === index) state(parent).winnerHadFill = false
  }
  const complete = index => {
    if (!state(index).completed) {
      state(index).completed = true; state(index).completedAt = time
      mark(index, 'roundtrip-completed')
    }
  }
  const refresh = () => {
    updateFlags()
    for (let index = 0; index < nodes.length; index++) {
      if (state(index).drain && !flags[index].active && !flags[index].pending) clearSubtree(index)
    }
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index], s = state(index)
      if (s.completed || s.drain) continue
      if (node.kind === 'strategy') { if (lot(index)?.roundTripComplete) complete(index); continue }
      if (node.operator === 'all') {
        if (!flags[index].active && !flags[index].pending && node.children.every(child => state(child).completed && !state(child).drain)) complete(index)
      } else if (node.operator === 'sequence') {
        const child = node.children[s.cursor]
        if (child !== undefined && state(child).completed && !state(child).drain) {
          s.cursor++; s.blockedThrough = time
          mark(index, 'sequence-advanced', { child: nodes[child].path, cursor: s.cursor })
        }
        if (s.cursor === node.children.length && !flags[index].active && !flags[index].pending) complete(index)
      } else if (s.winner !== null) {
        const winner = s.winner, empty = !s.winnerHadFill && !flags[winner].active && !flags[winner].pending
        const finished = s.winnerHadFill && state(winner).completed && !state(winner).drain
        if ((empty || finished) && !flags[index].active && !flags[index].pending && node.children.every(child => !state(child).drain)) {
          s.winner = null; s.winnerHadFill = false; s.blockedThrough = time
          mark(index, 'race-released', { winner: nodes[winner].path, cause: finished ? 'completed-roundtrip' : 'empty-entry' })
          if (finished) complete(index)
        }
      }
    }
  }
  const beginDrain = (index, cause, keepGate = false) => {
    if (state(index).drain) return
    state(index).drain = { phase: 'cancel', cause, keepGate }
    mark(index, 'subtree-draining', { cause })
    for (let parent = nodes[index].parent; parent !== null; parent = nodes[parent].parent) {
      const s = state(parent), branch = branchFor(parent, index), position = nodes[parent].children.indexOf(branch)
      const rewind = nodes[parent].operator === 'sequence' && position < s.cursor
      if (s.completed || rewind) {
        s.completed = false; s.completedAt = null
        if (rewind) { s.cursor = position; s.blockedThrough = time }
        mark(parent, 'descendant-reset', { child: nodes[branch].path, cursor: s.cursor })
      }
    }
  }
  const issue = (index, side, quantity, cashCapCents, reason) => {
    if (!quantity || state(index).lastActionTime === time) return false
    const node = nodes[index], s = state(index), id = 'i' + ++serial
    const intent = { id, owner: node.namespace, lotId: side === 'buy' ? id + ':lot' : s.lotId, asset: node.asset, side, quantity, cashCapCents, reason, time }
    const decision = ledger.admit(intent)
    s.lastActionTime = time
    mark(index, decision.admitted ? 'intent-admitted' : 'intent-skipped', { intentId: id, side, reason, disposition: decision.reason })
    if (!decision.admitted) return false
    s.lotId = intent.lotId; issued.set(id, { index, generation: s.generation, lotId: intent.lotId })
    observe(node.roles[side === 'buy' ? 'buy_process' : 'sell_process'].requirementId, null, true)
    updateFlags()
    timeline.push({ kind: 'dispatch-start', intentId: id, time })
    dispatch(copy(intent))
    timeline.push({ kind: 'dispatch-end', intentId: id, time })
    refresh()
    return true
  }
  const serviceDrain = index => {
    if (!state(index).drain) return
    const owners = new Set(scopeOwners(index))
    if (state(index).drain.phase === 'cancel') {
      const pendingIds = ledger.snapshot().tickets.filter(ticket => owners.has(ticket.owner) && !terminal(ticket)).map(ticket => ticket.id)
      for (const id of pendingIds) {
        const ticket = ledger.ticket(id)
        if (terminal(ticket) || ticket.cancellationRequested) continue
        ledger.requestCancel(id, time)
        mark(index, 'cancellation-requested', { intentId: id, cause: state(index).drain.cause })
        timeline.push({ kind: 'cancel-start', intentId: id, time })
        cancel(id)
        timeline.push({ kind: 'cancel-end', intentId: id, time })
        if (!state(index).drain) return
      }
      updateFlags()
      if (flags[index].pending) return
      state(index).drain.phase = 'liquidate'
      mark(index, 'liquidation-ready', { cause: state(index).drain.cause })
    }
    for (let child = index; child < nodes[index].scopeEnd; child++) {
      if (!state(index).drain) return
      if (nodes[child].kind !== 'strategy') continue
      const holding = lot(child)
      if (holding?.quantity > 0 && !holding.pending && readyPrice(nodes[child].asset)) issue(child, 'sell', holding.quantity, 0, state(index).drain.cause)
    }
    refresh()
  }
  const updateGate = index => {
    const node = nodes[index], rule = node.gate, s = state(index)
    if (rule.kind === 'none') return true
    if (rule.kind === 'event' && s.gateOpen && rule.ttlBars !== null && barIndex - s.gateOpenedBar >= rule.ttlBars) {
      s.gateOpen = false
      mark(index, 'gate-expired')
      if (rule.close === 'drain-and-reset') beginDrain(index, 'gate-close', true)
    }
    const condition = evaluate(rule.predicate, index)
    observe(node.requirementId + ':gate', condition)
    if (!condition.ready) return false
    if (rule.kind === 'state') {
      const wasOpen = s.gateOpen
      s.gateOpen = condition.value
      if (s.gateOpen !== wasOpen) {
        mark(index, s.gateOpen ? 'gate-opened' : 'gate-closed')
        if (!s.gateOpen && rule.close === 'drain-and-reset') beginDrain(index, 'gate-close', true)
      }
    } else {
      if (!s.drain && !s.gateOpen && !condition.value && rule.rearm === 'after-false-while-closed') s.gateArmed = true
      if (!s.drain && !s.gateOpen && s.gateArmed && condition.value && (rule.trigger === 'level' || !s.previousGate)) {
        s.gateOpen = true; s.gateArmed = false; s.gateOpenedBar = barIndex
        mark(index, 'gate-opened')
      }
    }
    s.previousGate = condition.value
    return s.gateOpen
  }
  const visit = (index, entries) => {
    const node = nodes[index], s = state(index)
    if (s.drain) { serviceDrain(index); return }
    if (node.reset) {
      const condition = evaluate(node.reset.predicate, index)
      observe(node.requirementId + ':reset', condition)
      const trigger = condition.ready && condition.value && (node.reset.trigger === 'level' || !s.previousReset)
      if (condition.ready) s.previousReset = condition.value
      if (trigger) { beginDrain(index, 'reset'); serviceDrain(index); return }
    }
    const gateOpen = updateGate(index)
    if (state(index).drain) { serviceDrain(index); return }
    if (s.completed) return
    if (node.kind === 'strategy') {
      if (!eligibleTime(index) || !readyPrice(node.asset) || s.lastActionTime === time) return
      const holding = lot(index)
      if (holding?.quantity > 0) {
        const entry = ledger.ticket(holding.entryIntentId)
        if (ir.contract.exitWhileEntryPending === 'wait-terminal' && !terminal(entry)) return
        const openSale = ledger.snapshot().tickets.some(ticket => ticket.owner === node.namespace && ticket.side === 'sell' && !terminal(ticket))
        if (openSale) return
        const condition = evaluate(node.roles.sell_reason.rule, index)
        observe(node.roles.sell_reason.requirementId, condition)
        if (condition.ready && condition.value) {
          const process = node.roles.sell_process.rule, step = assets.get(node.asset).quantityStep
          const available = holding.quantity - holding.reservedQuantity
          const quantity = process.kind === 'all' ? available : Math.max(step, Number(BigInt(available) * BigInt(process.basisPoints) / (10000n * BigInt(step))) * step)
          issue(index, 'sell', quantity, 0, 'exit')
        }
      } else if (entries && ancestorAllows(index) && !flags[index].pending) {
        const condition = evaluate(node.roles.buy_reason.rule, index)
        observe(node.roles.buy_reason.requirementId, condition)
        if (condition.ready && condition.value) { const size = sizing(index); issue(index, 'buy', size.quantity, size.cashCapCents, 'entry') }
      }
      return
    }
    entries = entries && gateOpen && eligibleTime(index)
    if (node.operator === 'sequence') {
      const child = node.children[s.cursor]
      if (child !== undefined && eligibleTime(index)) visit(child, entries)
    } else if (node.operator === 'race') {
      for (const child of node.children) {
        if (state(index).completed || !eligibleTime(index)) break
        const winner = state(index).winner
        if (winner !== null && winner !== child) {
          if (flags[child].active || flags[child].pending || state(child).drain) {
            beginDrain(child, 'race-release'); serviceDrain(child)
          }
        } else visit(child, entries)
      }
    } else for (const child of node.children) visit(child, entries)
    refresh()
  }
  const runtime = {
    ledger: Object.freeze(Object.fromEntries(['resources', 'ticket', 'lot', 'status', 'snapshot'].map(name => [name, ledger[name]]))),
    step(bar) {
      invariant(!stepping && object(bar) && integer(bar.time) && bar.time > lastBarTime && bar.time >= time && object(bar.prices), 'Bars must advance once in the common event chronology.')
      invariant(barIndex + 1 < ir.contract.barBudget, 'The declared completed-bar budget is exhausted.')
      invariant(Object.keys(bar).every(key => ['time', 'prices'].includes(key)) && Object.entries(bar.prices).every(([asset, price]) => assets.has(asset) && (price === null || Number.isSafeInteger(price) && price > 0)), 'A bar contains unknown assets or invalid prices.')
      time = bar.time; lastBarTime = time; barIndex++; prices = copy(bar.prices); stepping = true
      timeline.push({ kind: 'bar-start', bar: barIndex, time })
      for (const [asset, price] of Object.entries(prices)) if (price !== null) {
        const values = history.get(asset) || []
        values.push({ time, price })
        if (values.length > (windows.get(asset) || 1)) values.shift()
        history.set(asset, values)
      }
      for (const s of states) if (s.firstFillTime !== null && time > s.firstFillTime) s.holdingBars++
      try { refresh(); visit(0, true); refresh(); timeline.push({ kind: 'bar-end', bar: barIndex, time }) }
      finally { stepping = false }
      return runtime.snapshot()
    },
    reconcile(event) {
      if (receipts.has(event?.id)) {
        invariant(receipts.get(event.id) === canonical(event), 'A duplicate runtime receipt changed.')
        return ledger.reconcile(event)
      }
      invariant(object(event) && integer(event.time) && event.time >= time && (!stepping || event.time === time) && issued.has(event.intentId), 'A new receipt needs a dispatched intent and a valid runtime timestamp.')
      const applied = ledger.reconcile(event)
      receipts.set(event.id, canonical(event)); time = event.time
      timeline.push({ kind: 'receipt', id: event.id, time })
      const binding = issued.get(event.intentId), ticket = ledger.ticket(event.intentId), index = binding.index, s = state(index)
      if (binding.generation !== s.generation || binding.lotId !== s.lotId) return applied // Late acknowledgments cannot reactivate a cleared generation.
      if (event.kind === 'fill' && ticket.side === 'buy') {
        for (let ancestor = index; ancestor !== null; ancestor = nodes[ancestor].parent) if (state(ancestor).firstFillTime === null) state(ancestor).firstFillTime = time
      }
      if (terminal(ticket) && ticket.status !== 'filled' && (ticket.filledQuantity === 0 || ticket.side === 'sell')) s.blockedThrough = time
      if (ticket.side === 'buy' && (event.kind === 'fill' || event.kind === 'accepted' && !terminal(ticket))) {
        for (let ancestor = nodes[index].parent; ancestor !== null; ancestor = nodes[ancestor].parent) {
          const node = nodes[ancestor], parent = state(ancestor)
          if (node.operator !== 'race' || parent.completed || parent.drain) continue
          const branch = branchFor(ancestor, index)
          if (parent.winner === null && (node.policy.claim === 'broker-accepted' || event.kind === 'fill')) {
            parent.winner = branch; parent.winnerHadFill = event.kind === 'fill'
            mark(ancestor, 'race-acquired', { winner: nodes[branch].path, claim: node.policy.claim })
          } else if (parent.winner === branch && event.kind === 'fill') parent.winnerHadFill = true
        }
      }
      refresh()
      return applied
    },
    requestReset(path, at) {
      invariant(byPath.has(path) && integer(at) && at >= time && !stepping, 'Request a reset for an existing subtree in event order.')
      time = at; beginDrain(byPath.get(path), 'reset'); refresh()
    },
    status(path) {
      invariant(byPath.has(path), 'Unknown trading node.')
      const index = byPath.get(path), s = state(index)
      return { readiness: readiness(index), canInitiate: canInitiate(index), active: flags[index].active, pending: flags[index].pending,
        completedRoundTrip: s.completed && !s.drain, resetPhase: s.drain?.phase || null }
    },
    snapshot() {
      return copy({ version: 1, compositionSha256: ir.compositionSha256, clock: { time, lastBarTime, barIndex }, ledger: ledger.snapshot(),
        states: nodes.map((node, index) => ({ path: node.path, namespace: node.namespace, ...state(index), ...runtime.status(node.path) })),
        transitions, coverage: [...coverage].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([requirementId, counts]) => ({ requirementId, ...counts })), timeline })
    },
  }
  updateFlags()
  return runtime
}
