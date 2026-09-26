// Ordinary requirement-control fields compile to the existing qualified plan.
// This module creates neither independent observations nor personal approvals.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { compileTask } from './tasks.mjs'
import { compileRequirementPlan, validateRequirementPlan } from './requirements.mjs'
import { validateValuePath } from './shrinking.mjs'

export const REQUIREMENT_FIELD_LIMITS = Object.freeze({ targets: 128, cases: 512, valueNodes: 4096, valueDepth: 32, bytes: 32 * 1024 * 1024 })
const copy = value => JSON.parse(canonical(value))
const fields = (value, keys, label) => invariant(object(value) && Object.keys(value).every(key => keys.includes(key)), label + ' has unsupported fields.')
const text = (value, label) => { invariant(typeof value === 'string' && value.trim().length > 0, 'Enter ' + label + '.'); return value }
const integer = (value, label) => { invariant(typeof value === 'string' && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)), 'Enter a whole number for ' + label + '.'); return Number(value) }
const counter = (name, label) => ({ kind: 'counter', name, label })
const transition = (name, label) => ({ kind: 'transition', name, label })

export function requirementValueField(value) {
  let nodes = 0
  const encode = (item, depth) => {
    invariant(++nodes <= REQUIREMENT_FIELD_LIMITS.valueNodes && depth <= REQUIREMENT_FIELD_LIMITS.valueDepth, 'The witness value exceeds the supported field size or depth; no values were omitted.')
    if (item === null) return { kind: 'null' }
    if (Array.isArray(item)) return { kind: 'array', items: item.map(child => encode(child, depth + 1)) }
    if (object(item)) return { kind: 'object', entries: Object.entries(item).map(([name, child]) => ({ name, value: encode(child, depth + 1) })) }
    invariant(['string', 'number', 'boolean'].includes(typeof item) && (typeof item !== 'number' || Number.isFinite(item)), 'Witness fields require finite JSON values.')
    return { kind: typeof item, text: String(item) }
  }
  return encode(value, 0)
}

export function requirementFieldValue(value) {
  let nodes = 0
  const decode = (item, depth) => {
    invariant(++nodes <= REQUIREMENT_FIELD_LIMITS.valueNodes && depth <= REQUIREMENT_FIELD_LIMITS.valueDepth, 'The witness value exceeds the supported field size or depth.')
    invariant(object(item), 'Choose a type for every witness value.')
    if (item.kind === 'null') { fields(item, ['kind'], 'Null value'); return null }
    if (item.kind === 'array') { fields(item, ['kind', 'items'], 'Array value'); invariant(Array.isArray(item.items), 'An array field needs its items.'); return item.items.map(child => decode(child, depth + 1)) }
    if (item.kind === 'object') {
      fields(item, ['kind', 'entries'], 'Object value'); invariant(Array.isArray(item.entries), 'An object field needs its entries.')
      const names = new Set()
      return Object.fromEntries(item.entries.map(entry => {
        fields(entry, ['name', 'value'], 'Object entry')
        invariant(typeof entry.name === 'string' && !names.has(entry.name), 'Object field names must be distinct.'); names.add(entry.name)
        return [entry.name, decode(entry.value, depth + 1)]
      }))
    }
    fields(item, ['kind', 'text'], 'Scalar value')
    invariant(typeof item.text === 'string', 'Retain the text for every scalar field.')
    if (item.kind === 'string') return item.text
    if (item.kind === 'boolean') { invariant(['true', 'false'].includes(item.text), 'Choose true or false.'); return item.text === 'true' }
    invariant(item.kind === 'number' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(item.text.trim()) && Number.isFinite(Number(item.text)), 'Enter a finite number; an empty or unfinished number is not zero.')
    return Number(item.text)
  }
  return decode(value, 0)
}

function activationChoices(spec, compiled, node) {
  if (spec.domain !== 'lean-bench') return null // Explicit module-defined metrics.
  if (!compiled.operational) {
    const names = { strategy: ['buy', 'sell'], sequence: ['advance'], race: ['winner'], state_gate: ['open'], event_gate: ['open'], reset: ['reset'] }[node.semantic.kind] || []
    return names.map(name => transition(name, name.replaceAll('-', ' ')))
  }
  if (['buy_reason', 'sell_reason'].includes(node.role)) return [counter('true', 'Predicate became true'), counter('ready', 'Predicate had its required observations'), counter('evaluated', 'Predicate was evaluated')]
  if (['buy_process', 'sell_process'].includes(node.role)) return [counter('actions', 'Process proposed an action')]
  const choices = [transition('roundtrip-completed', 'Scope completed an actual round trip')]
  if (node.semantic.kind === 'strategy') choices.push(transition('intent-admitted', 'Order intention was admitted'), transition('intent-skipped', 'Order intention was skipped'))
  else if (node.semantic.kind === 'template') {
    if (node.semantic.operator === 'sequence') choices.push(transition('sequence-advanced', 'Sequence advanced to its next child'))
    if (node.semantic.operator === 'race') choices.push(transition('race-acquired', 'Race acquired an owner'), transition('race-released', 'Race released its owner'))
    if (node.semantic.gate?.kind && node.semantic.gate.kind !== 'none') {
      for (const name of ['evaluated', 'ready', 'true']) choices.push(counter('gate-' + name, 'Gate predicate ' + name))
      choices.push(transition('gate-opened', 'Gate opened'))
      if (node.semantic.gate.kind === 'state') choices.push(transition('gate-closed', 'State gate closed'))
      if (node.semantic.gate.kind === 'event' && node.semantic.gate.ttlBars !== null) choices.push(transition('gate-expired', 'Event gate lifetime expired'))
    }
    if (node.semantic.reset) for (const name of ['evaluated', 'ready', 'true']) choices.push(counter('reset-' + name, 'Reset predicate ' + name))
  } else return []
  choices.push(transition('subtree-draining', 'Scope began draining'), transition('subtree-cleared', 'Scope was cleared after draining'))
  return choices
}

function observationFields(value) {
  const rows = [], visit = (item, path) => {
    if (path.length > 32) return
    if (Array.isArray(item)) {
      if (path.length < 32) rows.push({ path: [...path, 'length'], kind: 'number', label: (path.length ? path.join(' / ') : 'Result') + ' / length' })
      item.forEach((child, index) => visit(child, [...path, index]))
    } else if (object(item)) for (const [key, child] of Object.entries(item)) {
      if (!['__proto__', 'prototype', 'constructor'].includes(key) && key.length > 0 && key.length <= 256) visit(child, [...path, key])
    } else rows.push({ path, kind: item === null ? 'null' : typeof item, label: path.length ? path.join(' / ') : 'Whole result' })
  }
  visit(value, []); return rows
}

export async function requirementFieldInventory(spec) {
  const tasks = [], rows = [], appendices = [], blocking = []
  for (const source of spec.tasks) {
    const task = await compileTask(spec, source, { requireReview: false, requireTaskReview: false, validateExpected: false }); tasks.push(task)
    for (const variant of task.information ? task.interpretations : [task]) {
      const readingId = variant === task ? null : variant.id, compiled = variant.compiled
      for (const requirement of compiled.checklist) {
        const node = compiled.composition.nodes.find(row => row.path === requirement.path)
        const identity = { taskId: task.id, readingId, requirementId: requirement.requirementId, path: requirement.path }
        if (!node) { appendices.push({ ...identity, role: requirement.role }); continue }
        const activation = activationChoices(spec, compiled, node)
        const replacements = spec.catalog.filter(bundle => bundle.id !== node.bundle.id && bundle.kind === node.kind && (bundle.role || 'node') === node.role
          && canonical(Object.entries(bundle.slots || {}).sort()) === canonical(node.ports.map(port => [port.name, port.role]).sort()))
          .map(bundle => ({ id: bundle.id, parameters: copy(bundle.parameters || {}), parameterSchema: copy(bundle.parameterSchema || {}) }))
        const row = { ...identity, key: canonical([task.id, readingId, requirement.requirementId]), bundleId: node.bundle.id, kind: node.kind, role: node.role,
          requirement: requirement.text || node.requirement, parameters: copy(node.parameters), parameterSchema: copy(spec.catalog.find(bundle => bundle.id === node.bundle.id).parameterSchema || {}),
          activationMode: activation === null ? 'module-declared' : activation.length ? 'instrumented' : 'unsupported', activationOptions: activation || [], replacements,
          root: copy(variant.root || task.root), variables: copy({ ...(task.variables || {}), ...(variant.variables || {}) }), input: copy(task.input ?? null), observationFields: observationFields(variant.expected) }
        if (row.activationMode === 'unsupported') blocking.push({ key: row.key, reason: 'No occurrence-level activation metric is supplied by this interpreter for ' + row.path + '.' })
        if (!row.observationFields.length) blocking.push({ key: row.key, reason: 'This outcome has no supported scalar assertion location.' })
        rows.push(row)
      }
    }
  }
  if (rows.length > REQUIREMENT_FIELD_LIMITS.targets || rows.length * 4 > REQUIREMENT_FIELD_LIMITS.cases) blocking.push({ key: null,
    reason: rows.length + ' occurrence targets require at least ' + rows.length * 4 + ' interpreter cases. The complete registry supports 128 targets and 512 cases; no occurrences were omitted.' })
  if (spec.experimentTemplate) blocking.push({ key: null, reason: 'The generated experiment template owns its qualification controls; this profile cannot mix a separate requirement registry.' })
  const bindingSha256 = await sha256(canonical({ domain: spec.domain, leanProfile: spec.leanProfile || null, catalog: spec.catalog, tasks: spec.tasks,
    grading: spec.protocol.grading, inputs: spec.inputs || [], runtimeSources: spec.runtimeSources || {} }))
  return { version: 1, bindingSha256, rows, appendices, tasks, limits: REQUIREMENT_FIELD_LIMITS, blocking,
    interpreterOptions: (spec.inputs || []).filter(input => input.path.endsWith('.mjs')).map(input => ({ path: input.path, sha256: input.sha256 })),
    needsInterpreters: spec.domain !== 'lean-bench' }
}

export function createRequirementFieldDraft(inventory) {
  return { version: 1, bindingSha256: inventory.bindingSha256, rationale: '', timeoutMs: '120000',
    ...(inventory.needsInterpreters ? { interpreters: { reference: '', independent: '', rationale: '' } } : {}),
    targets: inventory.rows.map(row => ({ key: row.key, rationale: '', activation: [{ kind: 'counter', name: '', minimum: '1' }],
      probes: [{ id: 'probe-1', input: requirementValueField(row.input), assertions: [] }], wrongReadings: [] })) }
}

function changedRoot(row, alternative) {
  const root = copy(row.root); let node = root
  for (const slot of row.path.split('/').slice(1)) { invariant(node.slots && Object.hasOwn(node.slots, slot), 'The selected occurrence path no longer exists.'); node = node.slots[slot] }
  if (alternative.kind === 'parameter') {
    fields(alternative, ['id', 'kind', 'parameter', 'value', 'rationale'], 'Parameter alternative')
    invariant(Object.hasOwn(row.parameters, alternative.parameter), 'Choose an existing local parameter.')
    const value = requirementFieldValue(alternative.value)
    invariant(['string', 'number', 'boolean'].includes(typeof value), 'A local parameter must be a scalar string, number or boolean.')
    node.params = { ...(node.params || {}), [alternative.parameter]: value }
  } else {
    fields(alternative, ['id', 'kind', 'bundleId', 'parameters', 'rationale'], 'Replacement alternative')
    invariant(alternative.kind === 'replacement' && row.replacements.some(bundle => bundle.id === alternative.bundleId), 'Choose a replacement with the same node kind, role and child slots.')
    invariant(object(alternative.parameters), 'Supply the replacement parameter fields.')
    node.use = alternative.bundleId
    node.params = Object.fromEntries(Object.entries(alternative.parameters).map(([name, field]) => {
      const value = requirementFieldValue(field); invariant(['string', 'number', 'boolean'].includes(typeof value), 'Replacement parameters must be scalar.'); return [name, value]
    }))
  }
  return root
}

export async function compileRequirementFields(spec, draft) {
  fields(draft, ['version', 'bindingSha256', 'rationale', 'timeoutMs', 'interpreters', 'targets'], 'Requirement fields')
  invariant(draft.version === 1 && new TextEncoder().encode(canonical(draft)).length <= REQUIREMENT_FIELD_LIMITS.bytes, 'Requirement fields have an unsupported version or exceed the 32 MiB budget.')
  const inventory = await requirementFieldInventory(spec)
  invariant(draft.bindingSha256 === inventory.bindingSha256, 'Tasks, readings, inputs, catalog or sources changed. Regenerate the occurrence roster and review the retained independent witness fields.')
  invariant(inventory.blocking.length === 0, inventory.blocking.map(row => row.reason).join(' '))
  invariant(Array.isArray(draft.targets) && draft.targets.length === inventory.rows.length && new Set(draft.targets.map(row => row.key)).size === inventory.rows.length,
    'Supply exactly one field record for every task, reading and occurrence; partial coverage cannot become a complete registry.')
  const supplied = new Map(draft.targets.map(row => [row.key, row]))
  const plan = { version: 1, selectedInput: { policy: 'require-composition', rationale: text(draft.rationale, 'the qualification rationale'), timeoutMs: integer(draft.timeoutMs, 'qualification timeout') },
    targets: inventory.rows.map((row, index) => {
      const target = supplied.get(row.key); fields(target, ['key', 'rationale', 'activation', 'probes', 'wrongReadings'], 'Occurrence fields')
      invariant(Array.isArray(target.activation) && target.activation.length > 0, 'Choose activation for ' + row.path + '.')
      const activation = target.activation.map(rule => {
        fields(rule, ['kind', 'name', 'minimum'], 'Activation fields')
        invariant(row.activationMode === 'module-declared' || row.activationOptions.some(option => option.kind === rule.kind && option.name === rule.name), 'Choose a metric actually supplied for ' + row.path + '.')
        return { kind: rule.kind, name: text(rule.name, 'an activation metric'), minimum: integer(rule.minimum, 'activation minimum') }
      })
      invariant(Array.isArray(target.probes) && target.probes.length > 0 && Array.isArray(target.wrongReadings) && target.wrongReadings.length > 0, 'Enter a witness and a plausible local alternative for ' + row.path + '.')
      return { id: 'requirement-' + (index + 1), taskId: row.taskId, ...(row.readingId ? { readingId: row.readingId } : {}), requirementId: row.requirementId,
        rationale: text(target.rationale, 'the requirement-control rationale'), activation,
        probes: target.probes.map(probe => {
          fields(probe, ['id', 'input', 'assertions'], 'Witness fields')
          invariant(Array.isArray(probe.assertions) && probe.assertions.length > 0, 'Enter an independent observable assertion for ' + row.path + '.')
          return { id: probe.id, input: requirementFieldValue(probe.input), assertions: probe.assertions.map(assertion => {
            fields(assertion, ['path', 'value'], 'Assertion fields'); validateValuePath(assertion.path)
            invariant(row.observationFields.some(option => canonical(option.path) === canonical(assertion.path)), 'Choose a supported observation location.')
            const equals = requirementFieldValue(assertion.value)
            invariant(equals === null || ['string', 'number', 'boolean'].includes(typeof equals), 'The current assertion fields support scalar values, including null.')
            return { path: copy(assertion.path), equals }
          }) }
        }), wrongReadings: target.wrongReadings.map(alternative => ({ id: alternative.id, root: changedRoot(row, alternative), rationale: text(alternative.rationale, 'why the alternative is plausible') })) }
    }) }
  if (inventory.needsInterpreters) {
    fields(draft.interpreters, ['reference', 'independent', 'rationale'], 'Interpreter fields')
    const reference = inventory.interpreterOptions.find(option => option.path === draft.interpreters.reference), independent = inventory.interpreterOptions.find(option => option.path === draft.interpreters.independent)
    invariant(reference && independent && reference.path !== independent.path && reference.sha256 !== independent.sha256, 'Select two distinct source-pinned interpreter modules.')
    plan.interpreters = { reference: reference.path, independent: independent.path, rationale: text(draft.interpreters.rationale, 'the interpreter independence rationale') }
  } else invariant(draft.interpreters === undefined, 'LEAN keeps its supplied independent counterpart; generic modules cannot replace it.')
  validateRequirementPlan(plan)
  const registry = await compileRequirementPlan({ ...spec, requirementPlan: plan }, inventory.tasks, { requireReview: false })
  invariant(registry.selectedInput.unregistered.length === 0 && registry.targets.length === inventory.rows.length, 'The generated registry does not cover its exact occurrence roster.')
  return { plan, registry, inventory }
}
