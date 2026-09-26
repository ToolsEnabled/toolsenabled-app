// Registered requirement witnesses. The machinery is domain-independent;
// interpreters supply observations and activation evidence explicitly.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { modernSchema } from './study-schema.mjs'
import { compileTask, deriveTaskExpected } from './tasks.mjs'
import { assertSequenceShrink, shrinkSequence, validateValuePath, valueAt } from './shrinking.mjs'
import { validateLean } from './lean.mjs'
import { validateTradingMarket } from './trading-market.mjs'
import { tradingObservationContract } from './trading-observations.mjs'

const ID = /^[a-z][a-z0-9_-]{0,63}$/
const fields = (value, keys, label) => invariant(object(value) && Object.keys(value).every(key => keys.includes(key)), label + ' contains unsupported fields.')
const distinct = (rows, label) => invariant(new Set(rows.map(row => row.id)).size === rows.length && rows.every(row => ID.test(row.id)), label + ' needs distinct lowercase identifiers.')
const rationale = value => invariant(typeof value === 'string' && value.trim() && value.length <= 16000, 'Explain the registered requirement or wrong reading.')

export const SELECTED_INPUT_PREPARATION_LIMITS = Object.freeze({ settlementMs: 5000, proofBytes: 4 * 1024 * 1024, journalBytes: 16 * 1024 * 1024, eventEvidenceBytes: 32 * 1024 * 1024 })

// A frozen control roster is executable apparatus, not a qualification receipt.
// Its aggregate limits are declarations for the later preparation host; exporting
// or running one auxiliary project cannot discharge the parent admission gate.
export const NATIVE_PREPARATION_LIMITS = Object.freeze({ jobs: 8192, planBytes: 4 * 1024 * 1024, cleanupAllowanceMs: 30000 })
export function validateNativePreparationPlan(spec) {
  const plan = spec.nativePreparationPlan
  if (plan === undefined) return
  invariant(modernSchema(spec) && spec.domain === 'lean-bench' && spec.protocol?.grading?.kind === 'lean-python', 'Native preparation controls require a schema-2-or-later Lean study with the lean-python grader.')
  invariant(spec.requirementPlan?.selectedInput?.policy === 'require-composition', 'Native preparation controls require complete selected-input composition registration.')
  fields(plan, ['version', 'coverage', 'rationale', 'referenceReplicates', 'mutantReplicates', 'budgets'], 'Native preparation plan')
  invariant(plan.version === 1 && plan.coverage === 'all-selected-readings-occurrences-and-probes', 'Native preparation retains every selected reading, occurrence and registered probe.')
  rationale(plan.rationale)
  invariant(Number.isSafeInteger(plan.referenceReplicates) && plan.referenceReplicates >= 3 && plan.referenceReplicates <= 20, 'Declare 3–20 fresh reference replicates per native control.')
  invariant(Number.isSafeInteger(plan.mutantReplicates) && plan.mutantReplicates >= 1 && plan.mutantReplicates <= 20, 'Declare 1–20 fresh mutant replicates per native control.')
  const budget = plan.budgets
  fields(budget, ['maxNativeExecutions', 'executionTimeoutMs', 'attemptTimeoutMs', 'maxDurationMs'], 'Native preparation budgets')
  const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
  invariant(bounded(budget.maxNativeExecutions, 1, 100000), 'Declare a native execution budget of 1–100000 starts.')
  invariant(bounded(budget.executionTimeoutMs, 100, 3570000), 'Declare a native execution timeout of 100–3570000 ms.')
  invariant(bounded(budget.attemptTimeoutMs, budget.executionTimeoutMs + NATIVE_PREPARATION_LIMITS.cleanupAllowanceMs, 3600000), 'The native control attempt timeout must include at least 30000 ms beyond execution for owned container cleanup.')
  invariant(bounded(budget.maxDurationMs, 1, 86400000), 'Declare a native preparation duration budget of 1 ms to one day.')
}

export function nativeControlContract(task) {
  // The synchronous observer has no independent contract object. Conservatively
  // bind the full semantic/input context instead of promising a smaller stable
  // projection. Operational controls use the actual public harness contract.
  return task.compiled.operational
    ? { profile: 'operational-v1', publicContract: tradingObservationContract(task.compiled.operational, task.input) }
    : { profile: 'synchronous-v1', semantic: task.compiled.semantic, input: task.input }
}

export function nativeControlSource(requirements, source) {
  const target = requirements?.targets.find(row => row.id === source.targetId)
  const probe = source.scope === 'selected-input' ? target?.selectedInput
    : source.scope === 'probe' ? target?.probes.find(row => row.id === source.probeId) : null
  invariant(probe && probe.id === source.probeId, 'The native control source is absent from its exact requirement registry.')
  const wrong = source.wrongReadingId === null ? null : probe.wrongReadings.find(row => row.id === source.wrongReadingId)
  invariant(source.wrongReadingId === null || wrong?.task, 'The native mutant has no constructible registered task.')
  return { target, probe, reference: probe.reference, program: wrong ? wrong.task : probe.reference }
}

export async function compileNativePreparationPlan(spec, requirements) {
  if (spec.nativePreparationPlan === undefined) return null
  // Public callers may edit a draft while hashing is pending. All subsequent
  // hashes and returned rows must refer to one privately captured source state.
  spec = structuredClone(spec); requirements = structuredClone(requirements)
  validateNativePreparationPlan(spec)
  invariant(requirements?.selectedInput?.policy === 'require-composition', 'Compile the selected-input requirement registry before native controls.')
  const { sha256: registryHash, ...registryBody } = requirements
  invariant(requirements.format === 'benchmark-requirement-registry' && requirements.version === 1
    && registryHash === await sha256(canonical(registryBody))
    && requirements.planSha256 === await sha256(canonical(spec.requirementPlan))
    && canonical(requirements.runtimeSources) === canonical(spec.runtimeSources || {}), 'Native preparation requires the exact source-bound requirement registry.')
  const recipe = spec.nativePreparationPlan, profile = spec.leanProfile || 'synchronous-v1', jobs = [], coverage = [], gaps = []
  const identities = new Map(), digest = value => sha256(canonical(value))
  const add = async (source, kind) => {
    const { reference, program } = nativeControlSource(requirements, source)
    const descriptor = { kind, profile, generator: profile === 'operational-v1' ? 'operationalReferenceProgram-v1' : 'inlineLeanProgram-v1',
      referenceTaskSha256: await digest(reference), programTaskSha256: await digest(program), inputSha256: await digest(program.input),
      referenceExpectedSha256: await digest(reference.expected), programExpectedSha256: await digest(program.expected),
      referenceContractSha256: await digest(nativeControlContract(reference)), programContractSha256: await digest(nativeControlContract(program)),
      replicates: kind === 'reference' ? recipe.referenceReplicates : recipe.mutantReplicates }
    const identity = await digest(descriptor)
    if (identities.has(identity)) return identities.get(identity)
    invariant(jobs.length < NATIVE_PREPARATION_LIMITS.jobs, 'The complete native control roster exceeds 8192 jobs; no coverage is silently truncated.')
    const id = 'native-' + identity
    jobs.push({ id, ...descriptor, source }); identities.set(identity, id); return id
  }
  for (const target of requirements.targets) {
    for (const [scope, probe] of [['selected-input', target.selectedInput], ...target.probes.map(probe => ['probe', probe])]) {
      invariant(probe, 'Native preparation cannot substitute probe input for a missing selected input.')
      const source = { targetId: target.id, scope, probeId: probe.id, wrongReadingId: null }
      const row = { targetId: target.id, taskId: target.taskId, readingId: target.readingId || null,
        requirementId: target.requirement.requirementId, scope, probeId: probe.id, referenceJobId: await add(source, 'reference'), mutants: [] }
      for (const wrong of probe.wrongReadings) {
        const gap = wrong.constructionError ? { kind: 'mutant-construction', reason: wrong.constructionError }
          : canonical(probe.reference.expected) === canonical(wrong.task.expected) ? { kind: 'indistinguishable-mutant', reason: 'The compiled observations coincide on this exact input; native execution cannot establish the required distinction by expectation alone.' } : null
        const jobId = wrong.constructionError ? null : await add({ ...source, wrongReadingId: wrong.id }, 'mutant')
        row.mutants.push({ wrongReadingId: wrong.id, jobId, gap })
        if (gap) gaps.push({ ...gap, targetId: target.id, scope, probeId: probe.id, wrongReadingId: wrong.id })
      }
      if (!row.mutants.length) gaps.push({ kind: 'no-mutants', targetId: target.id, scope, probeId: probe.id })
      coverage.push(row)
    }
  }
  for (const occurrence of requirements.selectedInput.unregistered) gaps.push({ kind: 'unregistered-composition', ...occurrence })
  const counts = { jobs: jobs.length, referenceJobs: jobs.filter(job => job.kind === 'reference').length,
    mutantJobs: jobs.filter(job => job.kind === 'mutant').length, nativeExecutions: jobs.reduce((sum, job) => sum + job.replicates, 0), coverageRows: coverage.length }
  if (counts.nativeExecutions > recipe.budgets.maxNativeExecutions) gaps.push({ kind: 'execution-budget', required: counts.nativeExecutions, available: recipe.budgets.maxNativeExecutions })
  if (recipe.budgets.maxDurationMs < recipe.budgets.attemptTimeoutMs) gaps.push({ kind: 'duration-budget', required: recipe.budgets.attemptTimeoutMs, available: recipe.budgets.maxDurationMs })
  const body = { format: 'benchmark-native-preparation-plan', version: 1, profile, recipeSha256: await digest(recipe), requirementsSha256: requirements.sha256,
    runtimeSources: spec.runtimeSources || {}, environment: spec.environment, inputBindings: spec.inputs,
    coverage, jobs, counts, budgets: recipe.budgets, gaps, apparatusRequirements: requirements.selectedInput.apparatusRequirements,
    coverageStatus: gaps.length ? 'incomplete' : 'complete', executionStatus: 'not-run',
    scope: 'Generated registered controls only. Each program runs under its own bound task and public execution contract. Future native evidence must agree with that task and separately distinguish the bound baseline observation; cross-contract baseline refusal is not detection. No controls have run. Aggregate preparation budgets, mounted-data and host provenance, independent interpreter activation/shrinking, separate apparatus controls, fresh invocation qualification and experimental admission remain unestablished. Individual auxiliary projects cannot qualify their parent.' }
  invariant(new TextEncoder().encode(canonical(body)).byteLength <= NATIVE_PREPARATION_LIMITS.planBytes, 'The complete native preparation plan exceeds 4 MiB; no coverage is silently truncated.')
  return { ...body, sha256: await digest(body) }
}
export function qualificationPreparationLedger(project, events) {
  if (!selectedInputGate(project)) return null
  const starts = events.filter(event => event.type === 'qualification-started'), rows = []
  for (const start of starts) {
    const terminal = events.find(event => ['qualification', 'qualification-failed'].includes(event.type) && event.preparationSeq === start.seq)
    rows.push({ startSeq: start.seq, terminalSeq: terminal?.seq ?? null, at: start.at,
      status: terminal ? terminal.type === 'qualification' ? 'qualified' : terminal.status : 'open',
      timeoutMs: start.timeoutMs, settlementMs: start.settlementMs, reservedMs: start.reservedMs,
      elapsedMs: terminal?.elapsedMs ?? null, budgetChargeMs: terminal?.budgetChargeMs ?? start.reservedMs,
      chargeBasis: terminal && terminal.status !== 'interrupted' ? 'measured' : 'reserved',
      settled: !!terminal && terminal.status !== 'interrupted', reason: terminal?.reason ?? null })
  }
  for (const event of events.filter(event => event.type === 'qualification' && event.preparationSeq === undefined)) rows.push({
    startSeq: null, terminalSeq: event.seq, at: event.at, status: 'legacy-qualified', timeoutMs: null, settlementMs: null, reservedMs: null,
    elapsedMs: null, budgetChargeMs: null, chargeBasis: 'unavailable', settled: null,
    reason: 'Legacy proof has no paired preparation timing; no duration or budget charge is inferred.' })
  rows.sort((a, b) => (a.startSeq ?? a.terminalSeq) - (b.startSeq ?? b.terminalSeq))
  const missingElapsed = rows.filter(row => row.elapsedMs === null).length, missingCharge = rows.filter(row => row.budgetChargeMs === null).length
  const knownElapsedMs = rows.reduce((sum, row) => sum + (row.elapsedMs ?? 0), 0), knownBudgetChargeMs = rows.reduce((sum, row) => sum + (row.budgetChargeMs ?? 0), 0)
  return { rows, preparations: rows.length, qualified: rows.filter(row => ['qualified', 'legacy-qualified'].includes(row.status)).length,
    missingElapsed, missingCharge, knownElapsedMs, knownBudgetChargeMs,
    elapsedMs: missingElapsed ? null : knownElapsedMs, budgetChargeMs: missingCharge ? null : knownBudgetChargeMs,
    open: rows.filter(row => row.status === 'open').length, interrupted: rows.filter(row => row.status === 'interrupted').length,
    maxPreparations: project.spec.protocol.maxTotalAttempts + 1, limits: SELECTED_INPUT_PREPARATION_LIMITS,
    scope: 'Study-scoped preparation only. Measured time includes qualifier settlement; reserved recovery time is not observed elapsed time. Legacy missing charges remain unavailable. Open or interrupted preparation does not establish interpreter termination. Preparation is separate from trial latency, provider accounting and offline time.' }
}

export function validateRequirementPlan(plan) {
  fields(plan, ['version', 'targets', 'shrink', 'selectedInput', 'interpreters'], 'Requirement plan')
  invariant(plan.version === 1 && Array.isArray(plan.targets) && plan.targets.length > 0 && plan.targets.length <= 128, 'Declare 1–128 requirement targets.')
  distinct(plan.targets, 'Requirement targets')
  if (plan.interpreters !== undefined) {
    fields(plan.interpreters, ['reference', 'independent', 'rationale'], 'Requirement interpreters')
    invariant(typeof plan.interpreters.reference === 'string' && typeof plan.interpreters.independent === 'string'
      && plan.interpreters.reference !== plan.interpreters.independent, 'Declare distinct reference and independent interpreter modules.')
    rationale(plan.interpreters.rationale)
  }
  if (plan.selectedInput !== undefined) {
    fields(plan.selectedInput, ['policy', 'rationale', 'timeoutMs'], 'Selected-input policy')
    invariant(['report', 'require-registered', 'require-composition'].includes(plan.selectedInput.policy), 'Choose report, require-registered, or require-composition selected-input qualification.')
    rationale(plan.selectedInput.rationale)
    invariant(Number.isSafeInteger(plan.selectedInput.timeoutMs) && plan.selectedInput.timeoutMs >= 100 && plan.selectedInput.timeoutMs <= 3600000, 'Set a selected-input qualification budget of 100–3600000 milliseconds.')
  }
  if (plan.shrink) {
    fields(plan.shrink, ['sequencePath', 'maxEvaluations'], 'Shrink policy'); validateValuePath(plan.shrink.sequencePath)
    invariant(Number.isSafeInteger(plan.shrink.maxEvaluations) && plan.shrink.maxEvaluations >= 1 && plan.shrink.maxEvaluations <= 256, 'Set a shrink budget of 1–256 evaluations per witness.')
  }
  let evaluations = 0
  for (const target of plan.targets) {
    fields(target, ['id', 'taskId', 'readingId', 'requirementId', 'rationale', 'activation', 'probes', 'wrongReadings'], 'Requirement target')
    invariant(ID.test(target.taskId) && (target.readingId === undefined || ID.test(target.readingId))
      && typeof target.requirementId === 'string' && target.requirementId.length <= 16000, 'Bind each target to its exact task, optional admissible reading and requirement ID.')
    rationale(target.rationale)
    invariant(Array.isArray(target.activation) && target.activation.length > 0 && target.activation.length <= 32, 'Declare activation counters or transitions; prose presence is not execution coverage.')
    for (const rule of target.activation) {
      fields(rule, ['kind', 'name', 'minimum'], 'Activation rule')
      invariant(['counter', 'transition'].includes(rule.kind) && /^[a-z][a-z0-9_-]{0,63}$/.test(rule.name)
        && Number.isSafeInteger(rule.minimum) && rule.minimum >= 1 && rule.minimum <= 1000000, 'Activation needs a named counter or transition and a positive minimum.')
    }
    invariant(Array.isArray(target.probes) && target.probes.length > 0 && target.probes.length <= 16, 'Declare 1–16 hand-checked probe inputs per requirement.')
    distinct(target.probes, 'Requirement probes')
    for (const probe of target.probes) {
      fields(probe, ['id', 'input', 'assertions'], 'Requirement probe')
      invariant(Object.hasOwn(probe, 'input') && Array.isArray(probe.assertions) && probe.assertions.length > 0 && probe.assertions.length <= 64, 'Every probe needs input and explicit observable assertions.')
      for (const assertion of probe.assertions) {
        fields(assertion, ['path', 'equals'], 'Observable assertion'); validateValuePath(assertion.path)
        invariant(Object.hasOwn(assertion, 'equals'), 'Declare an exact expected observable value, including null when intended.')
      }
    }
    invariant(Array.isArray(target.wrongReadings) && target.wrongReadings.length <= 16, 'Declare up to 16 wrong readings per requirement; an empty registry remains incomplete.')
    distinct(target.wrongReadings, 'Wrong readings')
    for (const wrong of target.wrongReadings) {
      fields(wrong, ['id', 'root', 'variables', 'rationale'], 'Wrong reading')
      invariant(object(wrong.root) && (wrong.variables === undefined || object(wrong.variables)), 'Each wrong reading needs its explicit typed root and optional variables.')
      rationale(wrong.rationale)
    }
    evaluations += (target.probes.length + (plan.selectedInput ? 1 : 0)) * (1 + target.wrongReadings.length)
  }
  invariant(evaluations <= 512, 'The requirement registry exceeds 512 interpreter cases before shrinking.')
  invariant(canonical(plan).length <= 32 * 1024 * 1024, 'The requirement plan exceeds its 32 MiB budget.')
  return plan
}

function localMeaning(node) { return { kind: node.kind, role: node.role, semantic: node.semantic, ports: node.ports } }
function requireIsolatedChange(baseline, wrong, path) {
  const before = baseline.composition.nodes, after = wrong.composition.nodes, byPath = new Map(after.map(node => [node.path, node]))
  invariant(before.length === after.length && before.every(node => byPath.has(node.path)), 'A wrong reading must preserve the complete node topology.')
  for (const node of before) {
    const changed = byPath.get(node.path)
    if (node.path === path) {
      invariant(node.kind === changed.kind && node.role === changed.role
        && canonical(node.ports.map(port => port.path).sort()) === canonical(changed.ports.map(port => port.path).sort()), 'A wrong reading must preserve the target role and child ownership.')
      invariant(canonical(localMeaning(node)) !== canonical(localMeaning(changed)), 'A registered wrong reading must change the target semantics or declared child order.')
    } else invariant(canonical(localMeaning(node)) === canonical(localMeaning(changed)), 'A wrong reading also changes an unrelated requirement: ' + node.path + '.')
  }
}

export async function compileRequirementPlan(spec, tasks, { requireReview = spec.requireReview === true } = {}) {
  if (!spec.requirementPlan) return null
  const plan = validateRequirementPlan(spec.requirementPlan), targets = [], registered = new Set()
  const compile = async source => {
    if (spec.domain === 'lean-bench') source.expected = await deriveTaskExpected(spec, source)
    return compileTask(spec, source, { requireReview, requireTaskReview: false })
  }
  const key = (taskId, readingId, requirementId) => canonical([taskId, readingId || null, requirementId])
  for (const target of plan.targets) {
    const task = tasks.find(task => task.id === target.taskId)
    invariant(task, 'A requirement target names an unknown task: ' + target.taskId + '.')
    const variant = target.readingId ? task.interpretations?.find(row => row.id === target.readingId) : task
    invariant(variant && (!task.information || target.readingId), 'Information tasks need an explicit admissible reading; a latent baseline cannot become their qualification oracle.')
    invariant(!target.readingId || task.information, 'A reading target requires an information task.')
    const requirement = variant.compiled.checklist.find(row => row.requirementId === target.requirementId)
    invariant(requirement && variant.compiled.composition.nodes.some(node => node.path === requirement.path), 'Bind a target to an exact composition requirement; execution appendices require separate apparatus controls.')
    const identity = key(task.id, target.readingId, target.requirementId)
    invariant(!registered.has(identity), 'Use multiple probes for the same requirement instead of duplicating its coverage row.')
    registered.add(identity)
    const base = { id: task.id, root: variant.root, variables: { ...(task.variables || {}), ...(variant.variables || {}) }, expected: variant.expected, split: task.split }
    const probes = []
    for (const probe of target.probes) {
      const reference = await compile({ ...base, input: probe.input })
      invariant(canonical(reference.compiled.semantic) === canonical(variant.compiled.semantic), 'A requirement probe changes its bound semantic task.')
      const wrongReadings = [], meanings = new Set()
      for (const wrong of target.wrongReadings) {
        const candidate = await compile({ ...base, input: probe.input, root: wrong.root, variables: { ...base.variables, ...(wrong.variables || {}) } })
        requireIsolatedChange(reference.compiled, candidate.compiled, requirement.path)
        const meaning = canonical(candidate.compiled.semantic)
        invariant(!meanings.has(meaning), 'Duplicate wrong-reading semantics cannot inflate registered coverage.')
        meanings.add(meaning)
        wrongReadings.push({ id: wrong.id, rationale: wrong.rationale, task: candidate })
      }
      probes.push({ id: probe.id, assertions: probe.assertions, reference, wrongReadings })
    }
    let selectedInput
    if (plan.selectedInput) {
      const input = Object.hasOwn(task, 'input') ? { input: task.input } : {}
      const reference = await compile({ ...base, ...input })
      invariant(canonical(reference.expected) === canonical(variant.expected)
        && canonical(reference.compiled.semantic) === canonical(variant.compiled.semantic), 'Selected-input qualification must preserve the exact bound task meaning and expected observation.')
      const wrongReadings = []
      for (const wrong of target.wrongReadings) {
        try {
          const candidate = await compile({ ...base, ...input, root: wrong.root, variables: { ...base.variables, ...(wrong.variables || {}) } })
          requireIsolatedChange(reference.compiled, candidate.compiled, requirement.path)
          wrongReadings.push({ id: wrong.id, rationale: wrong.rationale, task: candidate })
        } catch (error) {
          // A wrong reading valid on a probe can be invalid on the selected
          // input. Keep that failure; it cannot count as a detected behavior.
          wrongReadings.push({ id: wrong.id, rationale: wrong.rationale, constructionError: error.message || String(error) })
        }
      }
      selectedInput = { id: 'selected-input', inputSha256: await sha256(canonical(task.input ?? null)), expectedSha256: await sha256(canonical(variant.expected)),
        assertions: [{ path: [], equals: variant.expected }], reference, wrongReadings }
    }
    targets.push({ id: target.id, taskId: task.id, ...(target.readingId ? { readingId: target.readingId } : {}), rationale: target.rationale,
      requirement, promptSha256: variant.compiled.promptSha256, semanticSha256: await sha256(canonical(variant.compiled.semantic)), activation: target.activation, probes,
      ...(selectedInput ? { selectedInput } : {}) })
  }
  const unregistered = []
  for (const task of tasks) for (const variant of task.information ? task.interpretations : [task]) {
    const readingId = variant === task ? null : variant.id
    for (const row of variant.compiled.checklist) if (!registered.has(key(task.id, readingId, row.requirementId))) {
      unregistered.push({ taskId: task.id, ...(readingId ? { readingId } : {}), requirementId: row.requirementId, role: row.role })
    }
  }
  const packet = { format: 'benchmark-requirement-registry', version: 1, planSha256: await sha256(canonical(plan)), runtimeSources: spec.runtimeSources || {},
    targets, unregistered, ...(plan.shrink ? { shrink: plan.shrink } : {}) }
  if (plan.interpreters) packet.interpreters = { rationale: plan.interpreters.rationale,
    ...Object.fromEntries(['reference', 'independent'].map(kind => {
      const input = spec.inputs?.find(input => input.path === plan.interpreters[kind])
      invariant(input, 'Pin each qualification interpreter in the input manifest.')
      return [kind, { file: plan.interpreters[kind], sha256: input.sha256 }]
    })) }
  if (plan.selectedInput) {
    const composition = new Set()
    for (const task of tasks) for (const variant of task.information ? task.interpretations : [task]) for (const node of variant.compiled.composition.nodes) {
      composition.add(key(task.id, variant === task ? null : variant.id, node.path + '#' + node.bundle.id))
    }
    packet.selectedInput = { ...plan.selectedInput, compositionOccurrences: composition.size,
      unregistered: unregistered.filter(row => composition.has(key(row.taskId, row.readingId, row.requirementId))),
      apparatusRequirements: unregistered.filter(row => !composition.has(key(row.taskId, row.readingId, row.requirementId))) }
  }
  invariant(canonical(packet).length <= 128 * 1024 * 1024, 'The compiled requirement registry exceeds 128 MiB.')
  return { ...packet, sha256: await sha256(canonical(packet)) }
}

export function requirementProjectFiles(project) {
  return project.requirements ? { 'requirements/registry.json': JSON.stringify(project.requirements, null, 2) + '\n' } : {}
}

export function firstObservableDifference(left, right, path = []) {
  if (canonical(left) === canonical(right)) return null
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) => Array.isArray(left) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0)
    for (const key of keys) {
      const child = [...path, Array.isArray(left) ? Number(key) : key], a = Object.hasOwn(left, key), b = Object.hasOwn(right, key)
      if (!a || !b) return { path: child, reference: a ? { present: true, value: left[key] } : { present: false }, wrongReading: b ? { present: true, value: right[key] } : { present: false } }
      const difference = firstObservableDifference(left[key], right[key], child)
      if (difference) return difference
    }
  }
  return { path, reference: { present: true, value: left }, wrongReading: { present: true, value: right } }
}

function activationFor(rules, result) {
  return rules.map(rule => {
    const values = result.activation?.[rule.kind === 'counter' ? 'counters' : 'transitions'], value = values && Object.hasOwn(values, rule.name) ? values[rule.name] : null
    return { ...rule, actual: value, passed: Number.isSafeInteger(value) && value >= rule.minimum }
  })
}

// Project the per-occurrence evidence from an interpreter's complete result.
// Keeping this portable also lets journal verification check that reported
// counters and observations agree with the retained underlying interpretation.
export function requirementInterpretation(task, target, result) {
  const counters = {}, transitions = {}, path = target.requirement.path
  if (task.compiled.operational) {
    const id = task.compiled.checklist.find(row => row.path === path).requirementId
    for (const row of result.snapshot.coverage) {
      const prefix = row.requirementId === id ? '' : row.requirementId === id + ':gate' ? 'gate-' : row.requirementId === id + ':reset' ? 'reset-' : null
      if (prefix !== null) for (const name of ['evaluated', 'ready', 'true', 'actions']) counters[prefix + name] = row[name]
    }
    for (const row of result.snapshot.transitions) if (row.path === path) transitions[row.kind] = (transitions[row.kind] || 0) + 1
  } else {
    for (const key of result.coverage || []) if (key.startsWith(path + ':')) transitions[key.slice(path.length + 1)] = 1
  }
  return { observation: task.compiled.operational ? result.observation : result.trace, activation: { counters, transitions }, interpretation: result }
}
export async function qualifyRequirements(packet, { interpret, independent, validInput, signal = new AbortController().signal } = {}) {
  const { sha256: expectedHash, ...body } = packet
  invariant(packet.format === 'benchmark-requirement-registry' && expectedHash === await sha256(canonical(body)), 'The requirement registry changed.')
  const report = { format: 'benchmark-requirement-qualification', version: 1, registrySha256: packet.sha256,
    status: 'unavailable', targets: [], unregistered: packet.unregistered, nativeValidated: false, personalApproval: false,
    scope: 'Declared local interpreter witnesses only. Activation and rejection of these registered wrong readings do not imply coverage of undeclared semantics, native execution, or counted collection.' }
  if (typeof interpret !== 'function' || typeof independent !== 'function') return { ...report, reason: 'Supply both source-bound reference and independent interpreters for this domain.' }
  const execute = async (task, target) => {
    signal.throwIfAborted()
    try {
      const reference = await interpret(task, target), other = await independent(task, target)
      invariant(object(reference) && Object.hasOwn(reference, 'observation') && object(other) && Object.hasOwn(other, 'observation'), 'Both interpreters must return an explicit observation.')
      return { status: canonical(reference) === canonical(other) ? 'agreed' : 'disagreed', reference, independent: other }
    } catch (error) {
      signal.throwIfAborted()
      return { status: 'unavailable', error: error.message || String(error), ...(error.evidence ? { process: error.evidence } : {}) }
    }
  }
  for (const target of packet.targets) {
    const probes = [], killed = new Set(), registeredWrong = target.probes[0].wrongReadings.map(row => row.id)
    let selectedInput
    for (const probe of [...target.probes, ...(target.selectedInput ? [target.selectedInput] : [])]) {
      const selected = probe === target.selectedInput
      const baseline = await execute(probe.reference, target), assertions = probe.assertions.map(assertion => {
        const actual = baseline.reference ? valueAt(baseline.reference.observation, assertion.path) : { present: false }
        return { ...assertion, actual, passed: actual.present && canonical(actual.value) === canonical(assertion.equals) }
      })
      const activation = baseline.reference ? activationFor(target.activation, baseline.reference) : [], active = activation.length > 0 && activation.every(row => row.passed)
      const qualifiedReference = baseline.status === 'agreed' && assertions.every(row => row.passed), wrongReadings = []
      for (const wrong of probe.wrongReadings) {
        const outcome = wrong.constructionError ? { status: 'unavailable', error: wrong.constructionError, phase: 'construction' } : await execute(wrong.task, target)
        const difference = baseline.reference && outcome.reference ? firstObservableDifference(baseline.reference.observation, outcome.reference.observation) : null
        const detected = qualifiedReference && active && outcome.status === 'agreed' && difference !== null
        const record = { id: wrong.id, outcome, difference, detected }
        if (detected) {
          if (!selected) killed.add(wrong.id)
          if (packet.shrink && !selected) {
            try { record.shrink = await shrinkSequence(probe.reference.input, { path: packet.shrink.sequencePath, maxEvaluations: packet.shrink.maxEvaluations, signal,
              preserves: async input => {
                if (validInput && (!validInput(probe.reference, input) || !validInput(wrong.task, input))) return { preserved: false, reason: 'invalid-input', evidence: { kind: 'invalid-input' } }
                const left = await execute({ ...probe.reference, input }, target), right = await execute({ ...wrong.task, input }, target)
                invariant(left.status === 'agreed' && right.status === 'agreed', 'Shrink evaluation is unavailable or the independent interpreters disagree.')
                const activated = left.reference && activationFor(target.activation, left.reference).every(row => row.passed)
                return { preserved: activated === true
                  && firstObservableDifference(left.reference.observation, right.reference.observation) !== null,
                evidence: { kind: 'interpreter-comparison', reference: left, wrongReading: right },
                reason: left.status + '/' + right.status + (activated ? '/activated' : '/inactive') }
              } }) } catch (error) {
                signal.throwIfAborted(); record.shrink = { status: 'unavailable', error: error.message || String(error), oneMinimal: false }
              }
          }
        }
        wrongReadings.push(record)
      }
      const result = { id: probe.id, baseline, assertions, activation, active, qualifiedReference, wrongReadings }
      if (selected) selectedInput = { ...result, inputSha256: probe.inputSha256, expectedSha256: probe.expectedSha256,
        status: !qualifiedReference || wrongReadings.some(wrong => wrong.outcome.status !== 'agreed') ? 'failed'
          : !active || !wrongReadings.length || wrongReadings.some(wrong => !wrong.detected) ? 'incomplete' : 'qualified' }
      else probes.push(result)
    }
    const status = probes.some(probe => !probe.qualifiedReference || probe.wrongReadings.some(wrong => wrong.outcome.status !== 'agreed' || wrong.shrink?.status === 'unavailable')) ? 'failed'
      : registeredWrong.length === 0 || !probes.some(probe => probe.active) || registeredWrong.some(id => !killed.has(id))
        || probes.some(probe => probe.wrongReadings.some(wrong => wrong.shrink && !wrong.shrink.oneMinimal)) ? 'incomplete' : 'qualified'
    report.targets.push({ id: target.id, taskId: target.taskId, ...(target.readingId ? { readingId: target.readingId } : {}), requirement: target.requirement,
      status, registeredWrongReadings: registeredWrong.length, detectedWrongReadings: killed.size, probes, ...(selectedInput ? { selectedInput } : {}) })
  }
  report.status = report.targets.some(target => target.status === 'failed') ? 'failed' : report.targets.every(target => target.status === 'qualified') ? 'qualified' : 'incomplete'
  if (packet.selectedInput) {
    const registeredStatus = report.targets.some(target => target.selectedInput.status === 'failed') ? 'failed'
      : report.targets.every(target => target.selectedInput.status === 'qualified') ? 'qualified' : 'incomplete'
    report.selectedInput = { ...packet.selectedInput, registeredStatus,
      compositionStatus: registeredStatus === 'failed' ? 'failed' : registeredStatus === 'qualified' && !packet.selectedInput.unregistered.length ? 'qualified' : 'incomplete',
      registeredOccurrences: packet.targets.length, qualifiedOccurrences: report.targets.filter(target => target.selectedInput.status === 'qualified').length,
      scope: 'Exact selected inputs and explicit admissible readings; separate hand-checked probes are not substitutes for selected-input activation and wrong-reading discrimination. Runtime appendices remain separate apparatus/native obligations.' }
  }
  return report
}

export function selectedInputGate(project) {
  const selected = project.requirements?.selectedInput
  return selected && selected.policy !== 'report' ? selected : null
}

export function requirementInterpreterRequest(task, target = null) {
  return { task: { id: task.id, root: task.root, variables: task.variables || {}, input: task.input ?? null,
    compiled: { semantic: task.compiled.semantic, composition: task.compiled.composition } },
  target: target ? { requirement: target.requirement } : null }
}

// Validate retained raw comparisons and frozen bindings, not a reported pass
// flag. This verifies the evidence's internal consistency, not authenticated
// execution by a third party. The portable CLI obtains it from fresh local
// source-bound interpreter execution before allowing a collection attempt.
export function assertSelectedInputQualification(project, record) {
  const packet = project.requirements, gate = selectedInputGate(project), report = record?.requirements
  invariant(gate && record?.format === 'research-benchmark-qualification' && record.version === 1
    && record.projectSha256 === project.sha256 && report?.registrySha256 === packet.sha256
    && canonical(record.runtimeSources || {}) === canonical(project.spec.runtimeSources || {}), 'Selected-input qualification belongs to a different project, registry or runtime source.')
  invariant(report.format === 'benchmark-requirement-qualification' && report.version === 1 && Array.isArray(report.targets)
    && report.targets.length === packet.targets.length && canonical(report.unregistered) === canonical(packet.unregistered)
    && report.nativeValidated === false && report.personalApproval === false, 'Selected-input qualification omitted or added registered targets or changed its declared scope.')
  const executions = new Map()
  if (packet.interpreters) {
    invariant(Array.isArray(record.moduleExecutions), 'Qualification omitted its interpreter process evidence.')
    for (const execution of record.moduleExecutions) {
      invariant(['reference', 'independent'].includes(execution.kind)
        && canonical(execution.binding) === canonical(packet.interpreters[execution.kind]), 'Qualification interpreter source binding changed.')
      if (execution.error) continue // Failed shrink candidates remain diagnostic evidence.
      invariant(execution.process?.exitCode === 0 && !execution.process.signal, 'Qualification interpreter did not exit successfully.')
      let value
      try { value = JSON.parse(execution.process.stdout) } catch { invariant(false, 'Qualification interpreter stdout is not its recorded JSON result.') }
      invariant(object(value) && Object.hasOwn(value, 'output'), 'Qualification interpreter omitted its raw output.')
      const key = canonical([execution.kind, execution.request]), rows = executions.get(key) || []
      rows.push(value.output); executions.set(key, rows)
    }
  }
  const moduleEvidence = (task, target, outcome) => {
    for (const kind of ['reference', 'independent']) {
      const rows = executions.get(canonical([kind, requirementInterpreterRequest(task, target)])) || []
      const index = rows.findIndex(output => canonical(output) === canonical(outcome[kind]))
      invariant(index >= 0, 'Qualification observation lacks its source-bound raw interpreter execution.')
      rows.splice(index, 1)
    }
  }
  if (packet.interpreters) for (const task of project.tasks) for (const variant of task.information ? task.interpretations : [task]) {
    const check = record.checks?.find(row => row.taskId === task.id && (row.readingId || null) === (variant === task ? null : variant.id))
    invariant(check?.kind === 'independent-module-interpretation' && check.passed === true
      && canonical(check.reference) === canonical(check.independent) && canonical(check.reference?.observation) === canonical(variant.expected), 'Selected task lacks independently agreed interpreter execution.')
    moduleEvidence({ ...task, compiled: variant.compiled, root: variant.root || task.root, variables: { ...(task.variables || {}), ...(variant.variables || {}) } }, null, check)
  }
  const agreement = (outcome, task, target) => {
    const agreed = outcome?.status === 'agreed' && object(outcome.reference) && Object.hasOwn(outcome.reference, 'observation')
      && object(outcome.independent) && canonical(outcome.reference) === canonical(outcome.independent)
    if (agreed && project.spec.domain === 'lean-bench') invariant(canonical(requirementInterpretation(task, target, outcome.reference.interpretation)) === canonical(outcome.reference),
      'Reported activation or observation differs from the retained underlying interpreter result.')
    if (agreed && packet.interpreters) moduleEvidence(task, target, outcome)
    return agreed
  }
  const checkProbe = (target, probe, evidence, selected) => {
    invariant(evidence?.id === probe.id && agreement(evidence.baseline, probe.reference, target), 'Qualification needs independently agreed reference observations.')
    const assertions = probe.assertions.map(assertion => {
      const actual = valueAt(evidence.baseline.reference.observation, assertion.path)
      return { ...assertion, actual, passed: actual.present && canonical(actual.value) === canonical(assertion.equals) }
    }), activation = activationFor(target.activation, evidence.baseline.reference), active = activation.every(row => row.passed)
    invariant(canonical(evidence.assertions) === canonical(assertions) && assertions.every(row => row.passed)
      && canonical(evidence.activation) === canonical(activation) && evidence.active === active && evidence.qualifiedReference === true, 'Qualification assertions or activation flags differ from the raw reference evidence.')
    invariant(Array.isArray(evidence.wrongReadings) && evidence.wrongReadings.length === probe.wrongReadings.length, 'Qualification omitted or added registered wrong readings.')
    const killed = []
    for (let i = 0; i < probe.wrongReadings.length; i++) {
      const wrong = probe.wrongReadings[i], row = evidence.wrongReadings[i]
      invariant(!wrong.constructionError && row.id === wrong.id && agreement(row.outcome, wrong.task, target), 'A registered wrong reading lacks independently agreed execution.')
      const difference = firstObservableDifference(evidence.baseline.reference.observation, row.outcome.reference.observation), detected = active && difference !== null
      invariant(canonical(row.difference) === canonical(difference) && row.detected === detected, 'Wrong-reading detection differs from the raw observable difference.')
      if (detected) killed.push(wrong.id)
      if (!selected && packet.shrink && detected) assertSequenceShrink(probe.reference.input, packet.shrink, row.shrink, (attempt, input) => {
        if (attempt.evidence?.kind === 'invalid-input') {
          invariant(project.spec.domain === 'lean-bench', 'A generic shrink candidate needs interpreter evidence.')
          const valid = task => { try { task.compiled.operational ? validateTradingMarket(task.compiled.operational, input) : validateLean(task.compiled.semantic, input); return true } catch { return false } }
          invariant(!valid(probe.reference) || !valid(wrong.task), 'A supposedly invalid shrink input satisfies both frozen input contracts.')
          return false
        }
        if (!attempt.evidence && attempt.preserved === null && typeof attempt.error === 'string') return null
        invariant(attempt.evidence?.kind === 'interpreter-comparison', 'A shrink candidate lacks its retained interpreter comparison.')
        const left = attempt.evidence.reference, right = attempt.evidence.wrongReading
        invariant(agreement(left, { ...probe.reference, input }, target) && agreement(right, { ...wrong.task, input }, target), 'Shrink evidence lacks independently agreed execution.')
        return activationFor(target.activation, left.reference).every(rule => rule.passed)
          && firstObservableDifference(left.reference.observation, right.reference.observation) !== null
      })
      else invariant(row.shrink === undefined, 'Undeclared or selected-input shrinking cannot become qualification evidence.')
    }
    if (selected) invariant(evidence.inputSha256 === probe.inputSha256 && evidence.expectedSha256 === probe.expectedSha256
      && evidence.status === 'qualified' && active && killed.length > 0 && killed.length === probe.wrongReadings.length,
    'The exact selected input does not activate and distinguish every registered wrong reading.')
    return { active, killed }
  }
  for (let i = 0; i < packet.targets.length; i++) {
    const target = packet.targets[i], evidence = report.targets[i]
    invariant(evidence.id === target.id && evidence.taskId === target.taskId && evidence.readingId === target.readingId
      && canonical(evidence.requirement) === canonical(target.requirement) && evidence.probes?.length === target.probes.length,
    'Qualification target identity or probe bindings changed.')
    const probes = target.probes.map((probe, index) => checkProbe(target, probe, evidence.probes[index], false)), killed = new Set(probes.flatMap(probe => probe.killed))
    const wrongIds = target.probes[0].wrongReadings.map(row => row.id)
    invariant(evidence.status === 'qualified' && probes.some(probe => probe.active) && wrongIds.length > 0 && wrongIds.every(id => killed.has(id))
      && evidence.registeredWrongReadings === wrongIds.length && evidence.detectedWrongReadings === killed.size, 'Separate registered probe qualification is incomplete.')
    checkProbe(target, target.selectedInput, evidence.selectedInput, true)
  }
  const selected = report.selectedInput
  invariant(report.status === 'qualified' && selected?.registeredStatus === 'qualified'
    && canonical(Object.fromEntries(Object.keys(packet.selectedInput).map(key => [key, selected[key]]))) === canonical(packet.selectedInput)
    && selected.registeredOccurrences === packet.targets.length && selected.qualifiedOccurrences === packet.targets.length,
  'The selected-input coverage summary differs from its frozen occurrence registry.')
  const compositionStatus = gate.unregistered.length === 0 ? 'qualified' : 'incomplete'
  invariant(selected.compositionStatus === compositionStatus && (gate.policy !== 'require-composition' || compositionStatus === 'qualified'),
    'Selected-input qualification leaves unregistered composition requirements or admissible readings.')
  return record
}

// The synchronous journal checker verifies structure and raw comparisons.
// Execution, report generation and CLI verification also await these digests.
export async function verifySelectedInputQualification(project, record) {
  assertSelectedInputQualification(project, record)
  for (let i = 0; i < project.requirements.targets.length; i++) {
    const target = project.requirements.targets[i], evidence = record.requirements.targets[i]
    for (let j = 0; j < target.probes.length; j++) for (const wrong of evidence.probes[j].wrongReadings) {
      if (!wrong.shrink || !wrong.detected) continue
      const source = target.probes[j].reference.input, path = project.requirements.shrink.sequencePath, sequence = valueAt(source, path).value
      for (const attempt of wrong.shrink.attempts) {
        let input = structuredClone(source), retained = attempt.keptIndices.map(index => structuredClone(sequence[index]))
        if (path.length) valueAt(input, path.slice(0, -1)).value[path.at(-1)] = retained
        else input = retained
        invariant(attempt.inputSha256 === await sha256(canonical(input)), 'A shrink candidate digest differs from its exact reconstructed input.')
      }
    }
  }
  return record
}
export async function verifyQualificationJournal(project, events) {
  for (const event of events) if (event?.type === 'qualification') await verifySelectedInputQualification(project, event.record)
}

export function requirementReportFiles(record) {
  const report = record.requirements?.selectedInput ? JSON.parse(canonical(record.requirements)) : record.requirements
  if (!report) return {}
  const tables = {
    targets: [['target', 'task', 'reading', 'requirement', 'status', 'registered_wrong_readings', 'detected_wrong_readings'],
      ...report.targets.map(row => [row.id, row.taskId, row.readingId || '', row.requirement.requirementId, row.status, row.registeredWrongReadings, row.detectedWrongReadings])],
    probes: [['target', 'probe', 'interpreter_agreement', 'hand_assertions_passed', 'active'],
      ...report.targets.flatMap(target => target.probes.map(probe => [target.id, probe.id, probe.baseline.status, probe.assertions.every(row => row.passed), probe.active]))],
    'wrong-readings': [['target', 'probe', 'wrong_reading', 'interpreter_agreement', 'detected', 'first_observable_difference', 'original_sequence_length', 'retained_sequence_length', 'deletion_minimal', 'shrink_budget_exhausted'],
      ...report.targets.flatMap(target => target.probes.flatMap(probe => probe.wrongReadings.map(wrong => [target.id, probe.id, wrong.id, wrong.outcome.status, wrong.detected,
        wrong.difference ? canonical(wrong.difference) : '', wrong.shrink?.originalLength ?? '', wrong.shrink?.finalLength ?? '', wrong.shrink?.oneMinimal ?? '', wrong.shrink?.exhausted ?? ''])))],
    unregistered: [['task', 'reading', 'requirement', 'role'], ...report.unregistered.map(row => [row.taskId, row.readingId || '', row.requirementId, row.role])],
  }
  if (report.selectedInput) {
    tables['selected-inputs'] = [['target', 'task', 'reading', 'requirement', 'status', 'input_sha256', 'expected_sha256', 'active', 'activation'],
      ...report.targets.map(row => [row.id, row.taskId, row.readingId || '', row.requirement.requirementId, row.selectedInput.status,
        row.selectedInput.inputSha256, row.selectedInput.expectedSha256, row.selectedInput.active, canonical(row.selectedInput.activation)])]
    tables['selected-wrong-readings'] = [['target', 'wrong_reading', 'interpreter_agreement', 'detected', 'first_observable_difference'],
      ...report.targets.flatMap(target => target.selectedInput.wrongReadings.map(wrong => [target.id, wrong.id, wrong.outcome.status, wrong.detected, wrong.difference ? canonical(wrong.difference) : '']))]
    tables['selected-unregistered'] = [['task', 'reading', 'requirement', 'role'], ...report.selectedInput.unregistered.map(row => [row.taskId, row.readingId || '', row.requirementId, row.role])]
    tables['apparatus-requirements'] = [['task', 'reading', 'requirement', 'role'], ...report.selectedInput.apparatusRequirements.map(row => [row.taskId, row.readingId || '', row.requirementId, row.role])]
  }
  const csv = rows => rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\n') + '\n'
  const html = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  const md = value => String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')
  const label = value => value.replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase())
  const lead = 'Status for the declared registry: ' + report.status + '. ' + report.unregistered.length + ' requirement occurrences remain unregistered.'
  const identity = 'Frozen project: ' + record.projectSha256 + '. Requirement registry: ' + report.registrySha256 + '.'
  const markdown = ['# Requirement qualification', '', lead, '', identity, '', report.scope, '']
  const sections = []
  if (report.selectedInput) {
    const selected = report.selectedInput, lead = 'Selected-input policy: ' + selected.policy + '. Registered occurrences: ' + selected.registeredStatus
      + '; all composition occurrences: ' + selected.compositionStatus + '. ' + selected.qualifiedOccurrences + ' of ' + selected.compositionOccurrences
      + ' composition occurrences qualified. ' + selected.apparatusRequirements.length + ' runtime appendix requirements remain separately unassessed.'
    markdown.push(lead, '', selected.rationale, '', selected.scope, '')
    sections.push('<p>' + html(lead) + '</p><p>' + html(selected.rationale) + '</p><p>' + html(selected.scope) + '</p>')
  }
  for (const [name, rows] of Object.entries(tables)) {
    markdown.push('## ' + label(name), '', '| ' + rows[0].map(cell => md(label(cell))).join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |', ...rows.slice(1).map(row => '| ' + row.map(md).join(' | ') + ' |'), '')
    sections.push('<section><h2>' + html(label(name)) + '</h2><div class="table" tabindex="0" role="region" aria-label="' + html(label(name)) + ' table"><table><thead><tr>' + rows[0].map(cell => '<th scope="col">' + html(label(cell)) + '</th>').join('')
      + '</tr></thead><tbody>' + rows.slice(1).map(row => '<tr>' + row.map((cell, index) => '<td' + (rows[0][index] === 'first_observable_difference' ? ' class="observation"' : '') + '>' + html(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>')
  }
  return { 'qualification/requirements.json': JSON.stringify(report, null, 2) + '\n', 'qualification/report.md': markdown.join('\n'),
    'qualification/report.html': '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Requirement qualification</title>'
      + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin:auto;padding:24px;color:#18212a;background:#fff}p{overflow-wrap:anywhere}.table{overflow:auto}table{border-collapse:collapse;width:100%;min-width:56rem}th,td{min-width:8rem;padding:8px;text-align:left;vertical-align:top;border:1px solid #ccd2d8}td.observation{min-width:24rem;max-width:32rem;overflow-wrap:anywhere}th{background:#eef2f5}section{margin:28px 0}</style>'
      + '<main><h1>Requirement qualification</h1><p>' + html(lead) + '</p><p>' + html(identity) + '</p><p>' + html(report.scope) + '</p>' + sections.join('') + '</main></html>\n',
    ...Object.fromEntries(Object.entries(tables).map(([name, rows]) => ['qualification/' + name + '.csv', csv(rows)])) }
}
