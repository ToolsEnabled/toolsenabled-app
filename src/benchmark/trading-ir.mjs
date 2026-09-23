// Typed lowering of the Strategy/Template grammar. Every operator slot is a
// Node; gates and reset are scoped properties of a template, not substitute
// strategy nodes. Policy choices are explicit data and are not approvals.
import { canonical, invariant, object, sha256 } from './prompts.mjs'

/* PROMPT B. The four parts an operational strategy is made of, declared beside
   the contract that validates them rather than in the compiler. */
export const OPERATIONAL_STRATEGY_ROLES = Object.freeze(['buy_reason', 'buy_process', 'sell_reason', 'sell_process'])
const ROLES = OPERATIONAL_STRATEGY_ROLES
import { validateComposition, COMPOSITION_LIMITS } from './composition.mjs'
import { validateExecutionConfig } from './execution.mjs'

export const TRADING_IR_VERSION = 1
const copy = value => JSON.parse(canonical(value))
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const fields = (value, allowed, label) => invariant(object(value) && Object.keys(value).every(key => allowed.includes(key)), label + ' has unsupported fields.')
const bps = value => integer(value, 1, 10000)
const predicateKinds = ['above', 'below', 'cross_up', 'cross_down', 'above_sma', 'below_sma', 'after', 'and', 'or']

export function initialTradingState() {
  return { generation: 0, completed: false, completedAt: null, lastActionTime: null, blockedThrough: null,
    lotId: null, firstFillTime: null, holdingBars: 0, historyAfterTime: null,
    cursor: 0, winner: null, winnerHadFill: false, gateOpen: false, gateOpenedBar: null, gateArmed: true,
    previousGate: false, previousReset: false, drain: null }
}

function predicate(rule, contextAsset, assets, windows, depth = 0) {
  invariant(depth <= 64 && object(rule) && predicateKinds.includes(rule.kind), 'Unknown or excessively nested trading predicate.')
  if (['and', 'or'].includes(rule.kind)) {
    fields(rule, ['kind', 'clauses'], 'Combined predicate')
    invariant(Array.isArray(rule.clauses) && rule.clauses.length >= 2 && rule.clauses.length <= 4, 'A combined predicate needs 2–4 clauses.')
    return { kind: rule.kind, clauses: rule.clauses.map(clause => predicate(clause, contextAsset, assets, windows, depth + 1)) }
  }
  if (rule.kind === 'after') {
    fields(rule, ['kind', 'bars'], 'Holding predicate')
    invariant(integer(rule.bars, 1, 100000), 'A holding predicate needs 1–100000 completed bars.')
    return { kind: 'after', bars: rule.bars }
  }
  const asset = rule.asset || contextAsset
  invariant(assets.has(asset), 'A price predicate needs a declared asset.')
  const average = ['above_sma', 'below_sma'].includes(rule.kind)
  fields(rule, average ? ['kind', 'asset', 'period'] : ['kind', 'asset', 'value'], 'Price predicate')
  if (average) invariant(integer(rule.period, 2, 10000), 'A moving average requires a complete 2–10000-observation window.')
  else invariant(integer(rule.value, 1), 'A price threshold must be positive integer cents.')
  const window = average ? rule.period : ['cross_up', 'cross_down'].includes(rule.kind) ? 2 : 1
  windows.set(asset, Math.max(windows.get(asset) || 1, window))
  return average ? { kind: rule.kind, asset, period: rule.period } : { kind: rule.kind, asset, value: rule.value }
}

function gate(rule, assets, windows) {
  invariant(object(rule) && ['none', 'state', 'event'].includes(rule.kind), 'Declare a no, state or event gate.')
  if (rule.kind === 'none') { fields(rule, ['kind'], 'No gate'); return { kind: 'none' } }
  const allowed = ['kind', 'predicate', 'close']
  if (rule.kind === 'event') allowed.push('trigger', 'ttlBars', 'rearm')
  fields(rule, allowed, 'Gate')
  invariant(['block-entries', 'drain-and-reset'].includes(rule.close), 'Declare how a closed gate treats existing descendants.')
  const result = { kind: rule.kind, predicate: predicate(rule.predicate, null, assets, windows), close: rule.close }
  if (rule.kind === 'event') {
    invariant(['level', 'rising-edge'].includes(rule.trigger) && (rule.ttlBars === null || integer(rule.ttlBars, 1, 100000))
      && ['after-false-while-closed', 'subtree-reset'].includes(rule.rearm), 'An event gate needs an explicit trigger, lifetime and rearming rule.')
    Object.assign(result, { trigger: rule.trigger, ttlBars: rule.ttlBars, rearm: rule.rearm })
  }
  return result
}

function purchase(rule, asset) {
  if (rule.kind === 'shares') {
    fields(rule, ['kind', 'quantity', 'cashCapCents'], 'Fixed-quantity purchase')
    invariant(integer(rule.quantity, 1) && rule.quantity % asset.quantityStep === 0 && integer(rule.cashCapCents, 1), 'A fixed-quantity purchase needs its complete explicit cash cap.')
  } else {
    invariant(['cash_fraction', 'fixed_cash'].includes(rule.kind), 'Unknown purchase process.')
    fields(rule, rule.kind === 'cash_fraction' ? ['kind', 'basisPoints', 'feeAllowanceCents'] : ['kind', 'cashCents', 'feeAllowanceCents'], 'Budgeted purchase')
    invariant(integer(rule.feeAllowanceCents) && (rule.kind === 'cash_fraction' ? bps(rule.basisPoints) : integer(rule.cashCents, 1)), 'A budgeted purchase needs its allocation and explicit fee allowance.')
  }
  return copy(rule)
}
function sale(rule) {
  invariant(['all', 'fraction'].includes(rule.kind), 'Unknown private exit process.')
  fields(rule, rule.kind === 'all' ? ['kind'] : ['kind', 'basisPoints'], 'Exit process')
  invariant(rule.kind === 'all' || bps(rule.basisPoints), 'A partial exit needs 1–10000 basis points.')
  return copy(rule)
}
function operatorPolicy(operator, policy) {
  invariant(['all', 'race', 'sequence'].includes(operator), 'Unknown trading operator.')
  fields(policy, operator === 'race' ? ['claim', 'release', 'losers'] : operator === 'sequence' ? ['handoff'] : [], 'Operator policy')
  if (operator === 'race') invariant(['broker-accepted', 'first-fill'].includes(policy.claim)
    && policy.release === 'empty-or-complete-next-bar' && policy.losers === 'cancel-then-liquidate', 'RACE needs explicit acquisition, release and losing-inventory policies.')
  if (operator === 'sequence') invariant(policy.handoff === 'next-bar', 'Declare the sequence handoff boundary.')
  return copy(policy)
}
function resetRule(rule, assets, windows) {
  if (rule === null) return null
  fields(rule, ['predicate', 'trigger'], 'Subtree reset')
  invariant(['level', 'rising-edge'].includes(rule.trigger), 'Declare the reset trigger.')
  return { predicate: predicate(rule.predicate, null, assets, windows), trigger: rule.trigger }
}
const executionContract = (config, barBudget) => ({ dispatch: 'completed-bar-only', entryFailure: 'retry-next-bar',
  sameBar: 'one-action-per-strategy', completion: 'flat-and-terminal-roundtrip', reset: 'cancel-then-liquidate-before-clear',
  unreadyGate: 'block-entry-without-new-transition', resetTriggerHistory: 'preserve-requesting-controller',
  ancestorReset: 'invalidate-completion-rewind-sequence', raceReset: 'release-cleared-winning-child',
  controllerEventBudget: config.limits.events, barBudget, exitWhileEntryPending: config.exitWhileEntryPending, resetHistory: config.resetHistory })
const sortedWindows = windows => [...windows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([asset, observations]) => ({ asset, observations }))

export function validateTradingIR(ir) {
  fields(ir, ['format', 'version', 'compositionSha256', 'execution', 'contract', 'nodes', 'historyWindows'], 'Trading IR')
  invariant(ir.format === 'lean-operational-ir' && ir.version === TRADING_IR_VERSION && /^[a-f0-9]{64}$/.test(ir.compositionSha256), 'Unknown trading representation or composition binding.')
  validateExecutionConfig(ir.execution)
  const contract = ir.contract
  invariant(object(contract) && ['wait-terminal', 'owned-quantity'].includes(contract.exitWhileEntryPending) && ['retain-observations', 'restart-subtree'].includes(contract.resetHistory)
    && integer(contract.barBudget, 1, 1000000) && canonical(contract) === canonical(executionContract({ ...ir.execution, ...contract }, contract.barBudget)), 'Unknown or incomplete trading execution contract.')
  invariant(Array.isArray(ir.nodes) && ir.nodes.length > 0 && ir.nodes.length <= COMPOSITION_LIMITS.nodes, 'Trading nodes exceed their resource budget.')
  const assets = new Map(ir.execution.assets.map(asset => [asset.id, asset])), windows = new Map(), owners = [], paths = new Set()
  let pathSize = 0
  for (const [index, node] of ir.nodes.entries()) {
    fields(node, ['index', 'namespace', 'path', 'parent', 'slot', 'kind', 'children', 'scopeEnd', 'requirementId', 'roles', 'operator', 'policy', 'asset', 'gate', 'reset', 'initialState'], 'Trading node')
    invariant(node.index === index && node.namespace === 'n' + index && typeof node.path === 'string' && !paths.has(node.path)
      && integer(node.scopeEnd, index + 1, ir.nodes.length) && canonical(node.initialState) === canonical(initialTradingState()), 'Trading node identity, scope or initial state changed.')
    paths.add(node.path); pathSize += node.path.length
    invariant(pathSize <= COMPOSITION_LIMITS.paths, 'Trading paths exceed their resource budget.')
    invariant(index === 0 ? node.path === 'root' && node.parent === null && node.slot === null && node.scopeEnd === ir.nodes.length
      : integer(node.parent, 0, index - 1) && /^[a-z][a-z0-9_-]{0,63}$/.test(node.slot) && node.path === ir.nodes[node.parent].path + '/' + node.slot && ir.nodes[node.parent].children.includes(index), 'Trading parent ownership changed.')
    const linkedRequirement = (id, path) => typeof id === 'string' && id.startsWith(path + '#') && /^[a-z][a-z0-9_-]{0,63}$/.test(id.slice(path.length + 1))
    invariant(linkedRequirement(node.requirementId, node.path), 'A trading requirement lost its node binding.')
    invariant(Array.isArray(node.children) && new Set(node.children).size === node.children.length, 'Invalid or duplicated trading children.')
    let cursor = index + 1
    for (const child of node.children) {
      invariant(child === cursor && ir.nodes[child]?.parent === index && child < node.scopeEnd, 'Trading child scopes must follow contiguous declared preorder.')
      cursor = ir.nodes[child].scopeEnd
    }
    invariant(cursor === node.scopeEnd, 'Trading scope includes foreign descendants or omits its own children.')
    if (node.kind === 'strategy') {
      invariant(node.children.length === 0 && assets.has(node.asset) && node.operator === null && node.policy === null && canonical(node.gate) === canonical({ kind: 'none' }) && node.reset === null, 'Invalid strategy shape.')
      fields(node.roles, ROLES, 'Strategy roles')
      for (const role of ROLES) {
        const binding = node.roles[role]
        fields(binding, ['requirementId', 'rule'], 'Trading role binding')
        invariant(linkedRequirement(binding.requirementId, node.path + '/' + role) && object(binding.rule), 'A trading role lost its atomic requirement.')
        const checked = role.endsWith('reason') ? predicate(binding.rule, node.asset, assets, windows)
          : role === 'buy_process' ? purchase(binding.rule, assets.get(node.asset)) : sale(binding.rule)
        invariant(canonical(checked) === canonical(binding.rule), 'A trading role must use normalized explicit semantics.')
      }
      owners.push(node.namespace)
    } else {
      invariant(node.kind === 'template' && node.children.length >= 2 && node.children.length <= 4 && node.asset === null && node.roles === null, 'A recursive template requires 2–4 Node children.')
      operatorPolicy(node.operator, node.policy)
      invariant(canonical(gate(node.gate, assets, windows)) === canonical(node.gate) && canonical(resetRule(node.reset, assets, windows)) === canonical(node.reset), 'Gate or reset semantics are not normalized.')
    }
  }
  invariant(canonical(owners) === canonical(ir.execution.owners) && canonical(sortedWindows(windows)) === canonical(ir.historyWindows), 'Trading owners or declared history dependencies changed.')
  return ir
}

export async function lowerTradingIR(composition, config) {
  const { nodes: graph } = validateComposition(composition)
  fields(config, ['version', 'cashCents', 'currency', 'assets', 'limits', 'exitWhileEntryPending', 'resetHistory'], 'Trading execution contract')
  invariant(config.version === 1 && ['wait-terminal', 'owned-quantity'].includes(config.exitWhileEntryPending)
    && ['retain-observations', 'restart-subtree'].includes(config.resetHistory), 'Declare entry/exit concurrency and subtree history reset policies.')
  fields(config.limits, ['intents', 'events', 'bars'], 'Trading resource budgets')
  invariant(integer(config.limits.bars, 1, 1000000), 'Declare a bounded number of completed bars.')
  validateExecutionConfig({ version: 1, cashCents: config.cashCents, currency: config.currency, assets: config.assets, owners: ['validation'], limits: { intents: config.limits.intents, events: config.limits.events } })
  const assets = new Map((config.assets || []).map(asset => [asset.id, asset])), windows = new Map()
  const records = [], pending = [{ path: 'root', parent: null, slot: null, exit: false }], consumed = new Set()
  const requirement = node => node.path + '#' + node.bundle.id
  const local = node => copy(node.semantic)
  while (pending.length) {
    const frame = pending.pop()
    if (frame.exit) { records[frame.index].scopeEnd = records.length; continue }
    const node = graph.get(frame.path), semantic = local(node), index = records.length
    invariant(['strategy', 'template'].includes(semantic.kind) && node.role === 'node' && node.kind === 'template', 'Trading nodes must be four-role strategies or recursive templates.')
    consumed.add(node.path)
    const record = { index, namespace: 'n' + index, path: node.path, parent: frame.parent, slot: frame.slot, kind: semantic.kind,
      children: [], scopeEnd: null, requirementId: requirement(node), roles: null, operator: null, policy: null, asset: null, gate: { kind: 'none' }, reset: null,
      initialState: initialTradingState() }
    records.push(record)
    if (frame.parent !== null) records[frame.parent].children.push(index)
    pending.push({ exit: true, index })
    if (semantic.kind === 'strategy') {
      fields(semantic, ['kind', 'asset'], 'Strategy')
      invariant(assets.has(semantic.asset) && node.ports.length === ROLES.length && node.ports.every((port, i) => port.name === ROLES[i] && port.role === ROLES[i]), 'A strategy needs a declared asset and its four roles in canonical order.')
      record.asset = semantic.asset; record.roles = {}
      for (const role of ROLES) {
        const atom = graph.get(node.path + '/' + role)
        invariant(atom.kind === 'atom' && atom.role === role && atom.ports.length === 0, 'Each strategy role needs one typed atomic bundle.')
        consumed.add(atom.path)
        let rule = local(atom)
        if (role.endsWith('reason')) rule = predicate(rule, record.asset, assets, windows)
        else if (role === 'buy_process') rule = purchase(rule, assets.get(record.asset))
        else rule = sale(rule)
        record.roles[role] = { requirementId: requirement(atom), rule }
      }
    } else {
      fields(semantic, ['kind', 'operator', 'policy', 'gate', 'reset'], 'Recursive template')
      invariant(['all', 'race', 'sequence'].includes(semantic.operator) && node.ports.length >= 2 && node.ports.length <= 4 && node.ports.every(port => port.role === 'node'), 'ALL, RACE and SEQUENCE need 2–4 recursively typed Node slots.')
      record.operator = semantic.operator
      record.policy = operatorPolicy(semantic.operator, semantic.policy); record.gate = gate(semantic.gate, assets, windows)
      record.reset = resetRule(semantic.reset, assets, windows)
      for (const port of [...node.ports].reverse()) pending.push({ path: port.path, parent: index, slot: port.name, exit: false })
    }
  }
  invariant(consumed.size === composition.nodes.length, 'The trading composition contains an unconsumed semantic node.')
  const execution = { version: 1, cashCents: config.cashCents, currency: config.currency, assets: copy(config.assets),
    owners: records.filter(node => node.kind === 'strategy').map(node => node.namespace), limits: { intents: config.limits.intents, events: config.limits.events } }
  validateExecutionConfig(execution)
  const ir = { format: 'lean-operational-ir', version: TRADING_IR_VERSION, compositionSha256: await sha256(canonical(composition)), execution,
    contract: executionContract(config, config.limits.bars), nodes: records, historyWindows: sortedWindows(windows) }
  validateTradingIR(ir)
  return copy(ir)
}
