// Portable analysis of the frozen schedule and validated attempt journal.
// No GUI state or outcome-dependent cohort selection enters these calculations.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { modernSchema } from './study-schema.mjs'
import { conventionDistributions, interpretationObservation } from './conventions.mjs'
import { auditAnalysis } from './audit.mjs'
import { attemptDisposition, observationAnalysis } from './observations.mjs'
import { workflowAnalysis } from './workflow.mjs'
import { assertResourceExecution } from './resource-effects.mjs'
import { qualificationPreparationLedger } from './requirements.mjs'
import { resourcePreparationLedger } from './templates.mjs'

export const ANALYSIS_VERSION = 3
const PLAN_VERSION = 1
export const COHORTS = ['qualification', 'pilot', 'exploratory', 'confirmatory', 'legacy']
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
const fields = (value, allowed, label) => {
  invariant(object(value), label + ' must be an object.')
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key))
  invariant(!unsupported.length, label + ' has unsupported fields: ' + unsupported.join(', ') + '.')
}

// Execution purpose is immutable project provenance. A score, cohort or later
// audit cannot upgrade the operation under which source responses were drawn.
export function executionScope(project) {
  const describe = current => {
    const purpose = current.spec.schemaVersion === 1 ? 'legacy' : current.spec.executionPlan.purpose
    const scopes = {
      'apparatus-development': { evidenceClass: 'development-computations',
        scope: 'Apparatus development executes and tests the frozen apparatus. Its outcomes do not establish a qualified oracle, scientific inference or admitted experimental collection.',
        computationScope: 'Development computations; no scientific inference or admitted experimental collection.' },
      'recorded-diagnostic': { evidenceClass: 'recorded-diagnostics',
        scope: 'Recorded diagnostics check saved responses against the frozen grading rule. Answer-key self-consistency does not qualify the oracle or establish new experimental collection.',
        computationScope: 'Recorded diagnostic computations; no scientific inference or admitted experimental collection.' },
      legacy: { evidenceClass: 'legacy-evidence',
        scope: 'Legacy evidence retains its original project and observations. This runtime does not infer a modern execution purpose or retrospectively admit those observations as a qualified experiment.',
        computationScope: 'Legacy computations; modern experimental admission and scientific inference are not established.' },
      experiment: { evidenceClass: 'experiment-attempts',
        scope: 'Experiment attempts are assessed against the frozen admission and required proof contract. Static eligibility, passing scores and cohort labels do not establish scientific inference, personal approval or release readiness.',
        computationScope: 'Experiment computations subject to the frozen design, validated execution evidence and stated inference limits.' },
    }
    invariant(Object.hasOwn(scopes, purpose), 'Analysis needs a supported frozen execution purpose.')
    return { purpose, ...scopes[purpose], experimentalCollection: purpose === 'experiment' ? 'requires-validated-admission-and-proofs' : 'not-admitted' }
  }
  const result = describe(project), referenceAncestry = [], seen = new Set([project])
  for (let source = project.spec.auditPlan?.reference.project; source; source = source.spec.auditPlan?.reference.project) {
    invariant(!seen.has(source), 'Audit source ancestry cannot contain a cycle.'); seen.add(source)
    referenceAncestry.push({ projectSha256: source.sha256, ...describe(source) })
  }
  return { ...result, referenceAncestry }
}

// Resolve a prospective population from frozen design fields, never outcomes.
// All scheduled rows remain available for disposition and accounting.
export function resolveAnalysisPopulation(spec) {
  if (!spec.analysisPlan) return null
  const selection = spec.analysisPlan.primaryPopulation === undefined ? 'all' : spec.analysisPlan.primaryPopulation
  let includes, label, excludedReason
  if (spec.auditPlan) {
    invariant(selection === 'reference-eligible', 'A judge audit must declare reference-eligible cases as its primary population.')
    includes = task => task.audit?.referenceVerdict != null
    label = 'Reference-eligible audit cases'; excludedReason = 'unresolved-reference'
  } else if (selection === 'all') {
    includes = () => true; label = 'All frozen tasks'
  } else {
    invariant(object(selection), 'Choose all frozen tasks, a declared split, or an explicit frozen task set as the primary population.')
    if (selection.kind === 'split') {
      fields(selection, ['kind', 'split'], 'Primary population selector')
      invariant(['development', 'held-out'].includes(selection.split), 'The primary population split must be development or held-out.')
      includes = task => task.split === selection.split
      label = selection.split === 'held-out' ? 'Held-out tasks' : 'Development tasks'; excludedReason = 'outside-selected-split'
    } else {
      fields(selection, ['kind', 'taskIds'], 'Primary population selector')
      invariant(selection.kind === 'task-set' && Array.isArray(selection.taskIds) && selection.taskIds.length > 0 && selection.taskIds.length <= 512
        && selection.taskIds.every(validId) && new Set(selection.taskIds).size === selection.taskIds.length, 'Declare a nonempty primary task set with distinct frozen task IDs.')
      const known = new Set(spec.tasks.map(task => task.id)), chosen = new Set(selection.taskIds)
      invariant(selection.taskIds.every(id => known.has(id)), 'The primary task set names an unknown frozen task.')
      includes = task => chosen.has(task.id); label = 'Explicit frozen task set'; excludedReason = 'outside-explicit-task-set'
    }
    invariant(spec.tasks.some(includes), 'The declared primary population selects no frozen tasks.')
  }
  const ledger = spec.tasks.map(task => { const included = includes(task); return { taskId: task.id, split: task.split, included, reason: included ? null : excludedReason } })
  return { selection, label, taskIds: ledger.filter(row => row.included).map(row => row.taskId), ledger }
}

export function analysisProjectFiles(project) {
  return project.primaryPopulation ? { 'analysis/population.json': JSON.stringify(project.primaryPopulation, null, 2) + '\n' } : {}
}

export function validateAnalysisPlan(spec) {
  const plan = spec.analysisPlan
  const families = new Map()
  for (const task of spec.tasks) {
    if (task.familyId !== undefined) {
      invariant(validId(task.familyId), `${task.id}: familyId must be a lowercase identifier.`)
      invariant(!families.has(task.familyId) || families.get(task.familyId) === task.split, `${task.familyId}: one task family cannot cross development and held-out splits.`)
      families.set(task.familyId, task.split)
    }
    invariant(task.cohort === undefined || task.cohort === plan?.cohort, `${task.id}: task cohort differs from the frozen study cohort. Keep legacy and new study records separate.`)
    if (task.factors !== undefined) invariant(object(task.factors) && Object.entries(task.factors).every(([key, value]) => validId(key) && key !== 'split' && ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))), `${task.id}: factors must be named finite scalar values; split is reserved.`)
  }
  if (plan === undefined) return
  fields(plan, ['version', 'cohort', 'primaryDenominator', 'primaryPopulation', 'rationale', 'contrasts', 'multiplicity', 'uncertainty', 'endpoints'], 'Analysis plan')
  invariant(object(plan) && plan.version === PLAN_VERSION && COHORTS.includes(plan.cohort), 'The analysis plan needs version 1 and a declared cohort.')
  invariant(['scheduled', 'completed'].includes(plan.primaryDenominator), 'Choose scheduled or completed trials as the primary denominator before freezing.')
  const population = resolveAnalysisPopulation(spec)
  invariant(typeof plan.rationale === 'string' && plan.rationale.trim(), 'Record the analysis rationale before freezing.')
  invariant(Array.isArray(plan.contrasts) && plan.contrasts.length <= 64, 'Declare up to 64 planned condition contrasts, even when the list is empty.')
  const conditions = new Set(spec.conditions.map(condition => condition.id)), ids = new Set()
  for (const contrast of plan.contrasts) {
    fields(contrast, ['id', 'first', 'second'], 'Planned contrast')
    invariant(object(contrast) && validId(contrast.id) && !ids.has(contrast.id), 'Each planned contrast needs a unique identifier.')
    invariant(conditions.has(contrast.first) && conditions.has(contrast.second) && contrast.first !== contrast.second, `${contrast.id}: choose two distinct frozen conditions.`)
    ids.add(contrast.id)
  }
  invariant(plan.multiplicity === 'none-descriptive' || plan.multiplicity === 'bonferroni', 'Declare descriptive contrasts or Bonferroni simultaneous intervals.')
  if (plan.uncertainty !== null) {
    const uncertainty = plan.uncertainty, clustered = object(uncertainty) && uncertainty.kind === 'cluster-bootstrap'
    fields(uncertainty, ['kind', 'seed', 'iterations', 'confidence', ...(clustered ? ['clusterBy'] : [])], 'Uncertainty procedure')
    invariant(uncertainty.kind === 'family-bootstrap' || clustered, 'Choose a family bootstrap, a cluster bootstrap, or null for descriptive analysis without intervals.')
    invariant(Number.isSafeInteger(uncertainty.seed) && uncertainty.seed >= 0 && uncertainty.seed <= 0xffffffff, 'The bootstrap needs a frozen 32-bit seed.')
    invariant(Number.isSafeInteger(uncertainty.iterations) && uncertainty.iterations >= 100 && uncertainty.iterations <= 10000, 'Choose 100–10,000 bootstrap resamples.')
    invariant(Number.isFinite(uncertainty.confidence) && uncertainty.confidence >= 0.5 && uncertainty.confidence < 1, 'Choose a confidence level between 0.5 and 1 (exclusive).')
    if (clustered) invariant(uncertainty.clusterBy === 'familyId' || object(uncertainty.clusterBy), 'Cluster the bootstrap by familyId, or by { factor } naming a declared task factor.')
    const primaryTasks = spec.tasks.filter(task => population.taskIds.includes(task.id))
    if (clustered && uncertainty.clusterBy !== 'familyId') {
      fields(uncertainty.clusterBy, ['factor'], 'Cluster bootstrap unit')
      invariant(validId(uncertainty.clusterBy.factor) && primaryTasks.every(task => task.factors?.[uncertainty.clusterBy.factor] !== undefined), 'A factor cluster bootstrap needs a lowercase factor identifier declared on every primary-population task.')
    } else invariant(primaryTasks.every(task => validId(task.familyId)), 'Family bootstrap requires an explicit familyId for every primary-population task; variants and replicates retain their family.')
  }
  validateEndpoints(spec, plan)
}

// Design plan (spec.designPlan, contract version 1): a grouped assignment
// ledger. It annotates the frozen crossed schedule with arms (condition groups),
// draw units (tasks that share a factor level and run under one condition and
// replicate), member indices and ordered phases. It never adds trials; a phase
// may restrict which task factor levels it schedules, and every excluded trial
// identity is retained in the frozen design summary. Runtime, admission and
// budgets are untouched: this is representation and analysis grouping only.
export const DESIGN_PLAN_VERSION = 1
export const DESIGN_LIMITS = Object.freeze({ arms: 32, members: 8, phases: 16, contrasts: 64, draws: 100 })
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))
export function validateDesignPlan(spec) {
  const plan = spec.designPlan
  if (plan === undefined) return
  invariant(modernSchema(spec), 'A design plan requires specification version 2 or later.')
  fields(plan, ['version', 'rationale', 'arms', 'unit', 'phases', 'contrasts'], 'Design plan')
  invariant(plan.version === DESIGN_PLAN_VERSION, 'The design plan needs version 1.')
  invariant(typeof plan.rationale === 'string' && plan.rationale.trim(), 'Record the design rationale: what the arms, draws and phases mean for the study.')
  const conditionIds = (spec.conditions || []).map(condition => condition.id), tasks = spec.tasks || []
  if (plan.arms !== undefined) {
    invariant(Array.isArray(plan.arms) && plan.arms.length > 0 && plan.arms.length <= DESIGN_LIMITS.arms, 'Declare 1–' + DESIGN_LIMITS.arms + ' arms, or omit arms so each condition is its own arm.')
    const seen = new Set(), assigned = new Set()
    for (const arm of plan.arms) {
      fields(arm, ['id', 'conditionIds', 'label'], 'Arm')
      invariant(validId(arm.id) && !seen.has(arm.id) && !conditionIds.includes(arm.id), 'Each arm needs a distinct lowercase identifier that is not also a condition identifier.')
      seen.add(arm.id)
      invariant(Array.isArray(arm.conditionIds) && arm.conditionIds.length > 0 && arm.conditionIds.every(id => conditionIds.includes(id) && !assigned.has(id)), arm.id + ': list declared condition identifiers, each in exactly one arm.')
      for (const id of arm.conditionIds) assigned.add(id)
      invariant(arm.label === undefined || (typeof arm.label === 'string' && arm.label.trim() && arm.label.length <= 80), arm.id + ': the arm label is short text.')
    }
    invariant(assigned.size === conditionIds.length, 'Every condition must belong to exactly one arm.')
  }
  if (plan.unit !== undefined) {
    fields(plan.unit, ['kind', 'groupBy', 'members'], 'Assignment unit')
    invariant(plan.unit.kind === 'draw', 'The assignment unit kind is draw.')
    invariant(typeof plan.unit.groupBy === 'string' && /^factor:[a-z][a-z0-9_-]{0,63}$/.test(plan.unit.groupBy), 'Group the members of a draw by a task factor: groupBy is "factor:<id>".')
    invariant(Number.isSafeInteger(plan.unit.members) && plan.unit.members >= 1 && plan.unit.members <= DESIGN_LIMITS.members, 'Declare 1–' + DESIGN_LIMITS.members + ' members per draw.')
    const factor = plan.unit.groupBy.slice(7), counts = new Map()
    for (const task of tasks) {
      invariant(task.factors?.[factor] !== undefined, task.id + ': every task needs the draw factor ' + factor + '.')
      const key = canonical(task.factors[factor]); counts.set(key, (counts.get(key) || 0) + 1)
    }
    for (const [key, count] of counts) invariant(count === plan.unit.members, 'Draw group ' + key + ' has ' + count + ' task' + (count === 1 ? '' : 's') + '; every group needs exactly ' + plan.unit.members + '.')
  }
  if (plan.phases !== undefined) {
    invariant(Array.isArray(plan.phases) && plan.phases.length > 0 && plan.phases.length <= DESIGN_LIMITS.phases, 'Declare 1–' + DESIGN_LIMITS.phases + ' ordered phases.')
    const seen = new Set()
    let draws = 0
    for (const phase of plan.phases) {
      fields(phase, ['id', 'draws', 'factorLevels', 'requiresRecordedDecision'], 'Phase')
      invariant(validId(phase.id) && !seen.has(phase.id), 'Each phase needs a distinct lowercase identifier.')
      invariant(Number.isSafeInteger(phase.draws) && phase.draws >= 1 && phase.draws <= DESIGN_LIMITS.draws, phase.id + ': declare 1–' + DESIGN_LIMITS.draws + ' draws (replicates) for the phase.')
      draws += phase.draws
      if (phase.factorLevels !== undefined) invariant(object(phase.factorLevels) && Object.keys(phase.factorLevels).length > 0 && Object.entries(phase.factorLevels).every(([factor, levels]) => validId(factor)
        && tasks.some(task => task.factors?.[factor] !== undefined) && Array.isArray(levels) && levels.length > 0 && levels.every(scalar) && new Set(levels.map(canonical)).size === levels.length),
        phase.id + ': factor levels name declared task factors and list distinct scalar levels.')
      invariant(phase.requiresRecordedDecision === undefined || (typeof phase.requiresRecordedDecision === 'string' && seen.has(phase.requiresRecordedDecision)), phase.id + ': requiresRecordedDecision names an earlier phase.')
      seen.add(phase.id)
    }
    invariant(draws === spec.protocol?.replicates, 'Phase draws must sum to protocol.replicates (' + spec.protocol?.replicates + '); the phases declare ' + draws + '.')
  }
  if (plan.contrasts !== undefined) {
    invariant(Array.isArray(plan.contrasts) && plan.contrasts.length <= DESIGN_LIMITS.contrasts, 'Declare at most ' + DESIGN_LIMITS.contrasts + ' arm contrasts.')
    invariant(plan.arms !== undefined, 'Arm contrasts need declared arms.')
    const armIds = plan.arms.map(arm => arm.id), seen = new Set()
    for (const contrast of plan.contrasts) {
      fields(contrast, ['id', 'first', 'second'], 'Arm contrast')
      invariant(validId(contrast.id) && !seen.has(contrast.id), 'Each arm contrast needs a distinct lowercase identifier.')
      seen.add(contrast.id)
      invariant(armIds.includes(contrast.first) && armIds.includes(contrast.second) && contrast.first !== contrast.second, contrast.id + ': name two different declared arms.')
    }
  }
}
export function designProjectFiles(project) {
  return project.design ? { 'design/plan.json': JSON.stringify(project.design, null, 2) + '\n' } : {}
}
const unitStats = rows => {
  const completed = rows.filter(row => row.status === 'completed'), elapsed = completed.map(row => row.latencyMs).filter(value => Number.isFinite(value))
  return { members: rows.length, completedMembers: completed.length, allPassed: completed.length === rows.length && rows.every(row => row.passed === true),
    wallMs: elapsed.length === rows.length ? Math.max(...elapsed) : null, agentMs: elapsed.length === rows.length ? elapsed.reduce((sum, value) => sum + value, 0) : null }
}
// Arm-level and phase-level descriptive summaries plus the per-draw ledger.
function designAnalysis(project, rows, plan) {
  const design = project.design
  if (!design) return null
  const armRows = design.arms.map(arm => ({ arm: arm.id, label: arm.label ?? null, conditions: arm.conditionIds, ...measure(rows.filter(row => row.armId === arm.id)),
    primary: plan ? measure(rows.filter(row => row.armId === arm.id && row.primaryIncluded)) : null }))
  const unitsById = new Map()
  for (const row of rows) { if (row.unitId === undefined) continue; if (!unitsById.has(row.unitId)) unitsById.set(row.unitId, []); unitsById.get(row.unitId).push(row) }
  const units = [...unitsById.entries()].map(([unitId, members]) => {
    const sorted = [...members].sort((a, b) => a.memberIndex - b.memberIndex)
    return { unitId, armId: sorted[0].armId, conditionId: sorted[0].conditionId, group: sorted[0].unitGroup, replicate: sorted[0].replicate, phase: sorted[0].phase ?? null,
      memberTrials: sorted.map(row => row.id), ...unitStats(sorted) }
  })
  const phases = (design.phases || []).map(phase => ({ phase: phase.id, draws: phase.draws, ...measure(rows.filter(row => row.phase === phase.id)),
    requiresRecordedDecision: phase.requiresRecordedDecision ?? null, decision: phase.requiresRecordedDecision ? 'not-evaluated' : null }))
  return { version: DESIGN_PLAN_VERSION, arms: armRows, units, phases, excludedTrials: design.excludedTrials,
    limitations: [
      'Arms group frozen conditions for description and planned arm contrasts; membership of a condition in an arm is a design declaration, not an outcome.',
      ...(design.unit ? ['Draw units group the tasks that share one ' + design.unit.groupBy.slice(7) + ' level under one condition and replicate. Wall and agent times are arithmetic over the retained member attempt observations (the longest and the summed member times), available only when every member completed; they measure no concurrency, processor use or agent behaviour.'] : []),
      ...(design.phases ? ['Phases partition replicates in declared order. A phase decision is recorded only by a stop-rule evaluation; this analysis reports not-evaluated until one exists, and the runner does not gate phases.'] : []),
      ...(design.excludedTrials.length ? ['Trials outside a phase\'s factor levels were never scheduled; their identities are retained in the design summary.'] : []),
    ] }
}

// Typed endpoints (analysisPlan.endpoints, contract version 1) read one literal
// path each from the attempt record below. Values are never coerced: a missing
// path is unavailable, a wrong type is invalid, and both are counted, not imputed.
export const ENDPOINT_KINDS = ['binary', 'count', 'rate', 'duration', 'proportion', 'event-time']
export const ENDPOINT_RECORD_FIELDS = ['passed', 'score', 'elapsedMs', 'status', 'attempts', 'grade', 'reported', 'effects', 'response', 'unit']
const EXPOSURE_UNITS = ['ms', 'agent-ms', 'wall-ms', 'count']
const validPath = path => Array.isArray(path) && path.length > 0 && path.length <= 16 && ENDPOINT_RECORD_FIELDS.includes(path[0])
  && path.every(step => typeof step === 'string' ? step.length > 0 && step.length <= 64 : Number.isSafeInteger(step) && step >= 0)
function validateEndpoints(spec, plan) {
  if (plan.endpoints === undefined) return
  invariant(Array.isArray(plan.endpoints) && plan.endpoints.length > 0 && plan.endpoints.length <= 32, 'Declare 1–32 typed endpoints, or omit the endpoints field.')
  const ids = new Set()
  let primary = 0
  for (const endpoint of plan.endpoints) {
    fields(endpoint, ['id', 'kind', 'source', 'exposure', 'cap', 'direction', 'primary', 'unit', 'rationale'], 'Typed endpoint')
    invariant(validId(endpoint.id) && !ids.has(endpoint.id), 'Each typed endpoint needs a distinct lowercase identifier.')
    ids.add(endpoint.id)
    const label = endpoint.id + ': '
    invariant(ENDPOINT_KINDS.includes(endpoint.kind), label + 'choose a binary, count, rate, duration, proportion or event-time endpoint.')
    fields(endpoint.source, ['path'], label + 'endpoint source')
    invariant(validPath(endpoint.source.path), label + 'the source path must be a nonempty array of strings or nonnegative integers that starts at an attempt-record field (' + ENDPOINT_RECORD_FIELDS.join(', ') + ').')
    if (endpoint.kind === 'rate') {
      fields(endpoint.exposure, ['path', 'unit'], label + 'rate exposure')
      invariant(validPath(endpoint.exposure.path) && EXPOSURE_UNITS.includes(endpoint.exposure.unit), label + 'a rate endpoint needs an exposure path in the attempt record and a unit of ms, agent-ms, wall-ms or count.')
    } else invariant(endpoint.exposure === undefined, label + 'only rate endpoints declare an exposure denominator.')
    if (endpoint.kind === 'event-time') invariant(Number.isSafeInteger(endpoint.cap) && endpoint.cap > 0, label + 'an event-time endpoint needs a positive integer cap in milliseconds; values at or above it are censored.')
    else invariant(endpoint.cap === undefined, label + 'only event-time endpoints declare a censoring cap.')
    invariant(['higher-better', 'lower-better'].includes(endpoint.direction), label + 'declare higher-better or lower-better.')
    invariant(typeof endpoint.primary === 'boolean', label + 'declare primary as true or false.')
    invariant(typeof endpoint.unit === 'string' && endpoint.unit.trim() && endpoint.unit.length <= 32, label + 'name the measurement unit in at most 32 characters.')
    invariant(typeof endpoint.rationale === 'string' && endpoint.rationale.trim(), label + 'record the endpoint rationale.')
    if (endpoint.primary) {
      invariant(++primary === 1, 'Declare at most one primary typed endpoint.')
      invariant(spec.executionPlan?.purpose !== 'experiment' || endpoint.kind === 'binary' && canonical(endpoint.source.path) === '["passed"]',
        'The admitted experiment design supports the binary pass primary outcome only; declare other typed endpoints as secondary, or analyze them under apparatus development or recorded diagnostics.')
    }
  }
}

// The attempt record is the only surface an endpoint path can read. `trial` is
// the analysis row of the scheduled trial: its frozen schedule fields plus the
// status and attempt count reported in summary.rows. `project` and `lastEvent`
// complete the stable signature; version 1 derives nothing further from them.
export function endpointRecord(project, trial, completedEvent, lastEvent, unit = null) {
  const grade = completedEvent?.grade ?? null, output = completedEvent?.response?.output
  return { passed: grade?.passed ?? null, score: grade?.score ?? null, elapsedMs: completedEvent?.elapsedMs ?? null, status: trial.status, attempts: trial.attempts,
    grade, reported: completedEvent?.observations?.reported ?? null, effects: grade?.resourceEffects ?? null,
    response: { outputBytes: output === undefined ? null : new TextEncoder().encode(typeof output === 'string' ? output : canonical(output)).length },
    // Draw-level values from the design plan (null without one): the member
    // count, completed members, whether every member passed, the longest and
    // the summed member attempt times.
    unit: unit ? { members: unit.members, completedMembers: unit.completedMembers, allPassed: unit.allPassed, wallMs: unit.wallMs, agentMs: unit.agentMs } : null }
}
function valueAt(record, path) {
  let current = record
  for (const step of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, step)) return null
    current = current[step]
  }
  return current === undefined ? null : current
}
function endpointObservation(endpoint, record) {
  const value = valueAt(record, endpoint.source.path), invalid = expected => ({ status: 'invalid', value: null, reason: 'expected ' + expected })
  if (value === null) return { status: 'unavailable', value: null }
  switch (endpoint.kind) {
    case 'binary': case 'proportion': return typeof value === 'boolean' ? { status: 'observed', value } : invalid('a boolean')
    case 'count': return Number.isSafeInteger(value) && value >= 0 ? { status: 'observed', value } : invalid('a nonnegative integer')
    case 'duration': return Number.isFinite(value) && value >= 0 ? { status: 'observed', value } : invalid('nonnegative finite milliseconds')
    case 'event-time': return !(Number.isFinite(value) && value >= 0) ? invalid('nonnegative finite milliseconds') : value >= endpoint.cap ? { status: 'censored', value: endpoint.cap } : { status: 'observed', value }
    default: {
      if (!(Number.isSafeInteger(value) && value >= 0)) return invalid('a nonnegative integer numerator')
      const exposure = valueAt(record, endpoint.exposure.path)
      if (exposure === null) return { status: 'unavailable', value: null, exposure: null, reason: 'exposure unavailable' }
      if (!(Number.isFinite(exposure) && exposure >= 0)) return { ...invalid('nonnegative finite exposure'), exposure: null }
      return exposure === 0 ? { status: 'zero-exposure', value, exposure: 0 } : { status: 'observed', value, exposure }
    }
  }
}
const median = sorted => sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null
// Every estimator counts its denominators explicitly. `estimate` is the value
// that intervals, contrasts and the replicate diagnostic refer to.
function endpointEstimate(endpoint, observations, denominator) {
  const by = status => observations.filter(row => row.status === status), observed = by('observed'), scheduled = observations.length
  const base = { scheduled, unavailable: by('unavailable').length, invalid: by('invalid').length }
  switch (endpoint.kind) {
    case 'binary': case 'proportion': {
      const n = observed.length, k = observed.filter(row => row.value).length, rate = ratio(k, n), scheduledRate = ratio(k, scheduled)
      return { ...base, n, k, rate, scheduledRate, estimate: endpoint.kind === 'binary' && denominator === 'scheduled' ? scheduledRate : rate }
    }
    case 'count': { const n = observed.length, total = observed.reduce((sum, row) => sum + row.value, 0); return { ...base, n, total, mean: ratio(total, n), estimate: ratio(total, n) } }
    case 'rate': {
      const n = observed.length, numerator = observed.reduce((sum, row) => sum + row.value, 0), exposure = observed.reduce((sum, row) => sum + row.exposure, 0)
      return { ...base, zeroExposure: by('zero-exposure').length, n, numerator, exposure, unit: endpoint.exposure.unit, rate: ratio(numerator, exposure), estimate: ratio(numerator, exposure) }
    }
    case 'duration': {
      const sorted = observed.map(row => row.value).sort((a, b) => a - b), n = sorted.length, mean = n ? sorted.reduce((sum, value) => sum + value, 0) / n : null
      return { ...base, n, mean, median: median(sorted), min: n ? sorted[0] : null, max: n ? sorted[n - 1] : null, estimate: mean }
    }
    default: {
      // Censored values sort after every observed time. The median is the
      // smallest time by which at least half of the trials had the event; it
      // exists exactly when at least half of them are observed before the cap.
      const censored = by('censored'), n = observed.length + censored.length
      const sorted = [...observed.map(row => row.value), ...censored.map(() => Infinity)].sort((a, b) => a - b)
      const medianObserved = n && Number.isFinite(sorted[Math.ceil(n / 2) - 1]) ? sorted[Math.ceil(n / 2) - 1] : null
      return { ...base, n, observed: observed.length, censored: censored.length, cap: endpoint.cap, medianObserved, estimate: medianObserved }
    }
  }
}
const factorCluster = uncertainty => uncertainty?.kind === 'cluster-bootstrap' && uncertainty.clusterBy !== 'familyId' ? uncertainty.clusterBy.factor : null
const clusterKey = uncertainty => { const factor = factorCluster(uncertainty); return factor === null ? row => row.familyId : row => row.factors[factor] === undefined ? null : canonical(row.factors[factor]) }
const clusterUnit = uncertainty => factorCluster(uncertainty) === null ? 'family' : 'cluster'
// Percentile bootstrap over whole clusters: each draw resamples clusters with
// replacement and recomputes the statistic from their retained observations.
function clusterInterval(plan, clusters, statistic, count, paired) {
  const uncertainty = plan.uncertainty, unit = clusterUnit(uncertainty)
  if (clusters.length < 2) return { clusters: clusters.length, interval: null, intervalReason: 'At least two ' + (unit === 'family' ? 'task families' : 'clusters') + ' are needed for a ' + unit + ' bootstrap.' }
  const random = rng(uncertainty.seed), draws = []
  for (let i = 0; i < uncertainty.iterations; i++) {
    const sample = []
    for (let j = 0; j < clusters.length; j++) sample.push(clusters[Math.floor(random() * clusters.length)])
    const value = statistic(sample)
    if (value === null) return { clusters: clusters.length, interval: null, intervalReason: 'A bootstrap resample has no estimable value; no interval is reported.', resamplesRequested: uncertainty.iterations }
    draws.push(value)
  }
  draws.sort((a, b) => a - b)
  const alpha = (1 - uncertainty.confidence) / (plan.multiplicity === 'bonferroni' ? Math.max(1, count) : 1)
  return { clusters: clusters.length, interval: { low: quantile(draws, alpha / 2), high: quantile(draws, 1 - alpha / 2), kind: (paired ? 'paired ' : '') + unit + ' percentile bootstrap',
    clusterBy: uncertainty.kind === 'family-bootstrap' ? 'familyId' : uncertainty.clusterBy, confidence: uncertainty.confidence, multiplicity: plan.multiplicity, seed: uncertainty.seed, resamples: draws.length } }
}
function endpointAnalysis(project, plan, rows, records, cells, design = null) {
  const endpoints = plan.endpoints, conditions = project.spec.conditions.map(condition => condition.id), denominator = plan.primaryDenominator, key = clusterKey(plan.uncertainty)
  const observations = records.map(record => Object.fromEntries(endpoints.map(endpoint => [endpoint.id, endpointObservation(endpoint, record)])))
  const primary = rows.map((row, index) => ({ row, values: observations[index] })).filter(entry => entry.row.primaryIncluded)
  const estimate = (endpoint, entries) => endpointEstimate(endpoint, entries.map(entry => entry.values[endpoint.id]), denominator)
  const clustered = entries => {
    const groups = new Map()
    for (const entry of entries) { const cluster = key(entry.row); if (cluster !== null) { if (!groups.has(cluster)) groups.set(cluster, []); groups.get(cluster).push(entry) } }
    return [...groups.keys()].sort().map(cluster => groups.get(cluster))
  }
  const undeclared = { clusters: null, interval: null, intervalReason: 'No uncertainty procedure was declared.' }
  const groups = endpoints.flatMap(endpoint => conditions.map(condition => {
    const entries = primary.filter(entry => entry.row.conditionId === condition)
    return { condition, endpoint: endpoint.id, kind: endpoint.kind, unit: endpoint.unit, direction: endpoint.direction, primary: endpoint.primary, ...estimate(endpoint, entries),
      ...(plan.uncertainty ? clusterInterval(plan, clustered(entries), sample => estimate(endpoint, sample.flat()).estimate, endpoints.length * conditions.length, false) : undeclared) }
  }))
  const strata = cells.flatMap(cell => endpoints.map(endpoint => ({ dimension: cell.dimension, value: cell.value, condition: cell.condition, endpoint: endpoint.id, kind: endpoint.kind, ...estimate(endpoint, primary.filter(entry => cell.selects(entry.row))) })))
  // Descriptive exchangeability diagnostic: the estimate by replicate index.
  const replicates = endpoints.flatMap(endpoint => conditions.flatMap(condition => Array.from({ length: project.spec.protocol.replicates }, (_, index) => {
    const stats = estimate(endpoint, primary.filter(entry => entry.row.conditionId === condition && entry.row.replicate === index + 1))
    return { condition, endpoint: endpoint.id, replicate: index + 1, n: stats.n, estimate: stats.estimate }
  })))
  const contrasts = plan.contrasts.flatMap(contrast => endpoints.map(endpoint => {
    const side = id => primary.filter(entry => entry.row.conditionId === id), first = estimate(endpoint, side(contrast.first)).estimate, second = estimate(endpoint, side(contrast.second)).estimate
    const result = { id: contrast.id, first: contrast.first, second: contrast.second, endpoint: endpoint.id, kind: endpoint.kind, definition: 'first minus second', firstEstimate: first, secondEstimate: second, difference: first === null || second === null ? null : first - second }
    if (!plan.uncertainty) return { ...result, ...undeclared }
    // Whole clusters keep their rows in both conditions together, preserving pairing.
    const clusters = clustered([...side(contrast.first), ...side(contrast.second)])
    if (result.difference === null) return { ...result, clusters: clusters.length, interval: null, intervalReason: 'Both conditions need an estimable value before a contrast interval.' }
    return { ...result, ...clusterInterval(plan, clusters, sample => {
      const rows = sample.flat(), a = estimate(endpoint, rows.filter(entry => entry.row.conditionId === contrast.first)).estimate, b = estimate(endpoint, rows.filter(entry => entry.row.conditionId === contrast.second)).estimate
      return a === null || b === null ? null : a - b
    }, endpoints.length * plan.contrasts.length, true) }
  }))
  const primaryEndpoint = endpoints.find(endpoint => endpoint.primary) || null, factor = factorCluster(plan.uncertainty)
  // Arm-level estimates and planned arm contrasts reuse the same estimators
  // and cluster intervals; an arm is the union of its conditions' rows.
  const armRows = id => primary.filter(entry => entry.row.armId === id)
  const armIds = design ? design.arms.map(arm => arm.arm) : [], plannedArmContrasts = design ? project.design?.contrasts || [] : []
  const arms = design ? endpoints.flatMap(endpoint => armIds.map(id => ({ arm: id, endpoint: endpoint.id, kind: endpoint.kind, unit: endpoint.unit, direction: endpoint.direction, primary: endpoint.primary, ...estimate(endpoint, armRows(id)),
    ...(plan.uncertainty ? clusterInterval(plan, clustered(armRows(id)), sample => estimate(endpoint, sample.flat()).estimate, endpoints.length * armIds.length, false) : undeclared) }))) : null
  const armContrasts = design ? plannedArmContrasts.flatMap(contrast => endpoints.map(endpoint => {
    const first = estimate(endpoint, armRows(contrast.first)).estimate, second = estimate(endpoint, armRows(contrast.second)).estimate
    const result = { id: contrast.id, first: contrast.first, second: contrast.second, endpoint: endpoint.id, kind: endpoint.kind, definition: 'first minus second', firstEstimate: first, secondEstimate: second, difference: first === null || second === null ? null : first - second }
    if (!plan.uncertainty) return { ...result, ...undeclared }
    const clusters = clustered([...armRows(contrast.first), ...armRows(contrast.second)])
    if (result.difference === null) return { ...result, clusters: clusters.length, interval: null, intervalReason: 'Both arms need an estimable value before a contrast interval.' }
    return { ...result, ...clusterInterval(plan, clusters, sample => {
      const rows = sample.flat(), a = estimate(endpoint, rows.filter(entry => entry.row.armId === contrast.first)).estimate, b = estimate(endpoint, rows.filter(entry => entry.row.armId === contrast.second)).estimate
      return a === null || b === null ? null : a - b
    }, endpoints.length * plannedArmContrasts.length, true) }
  })) : null
  return { version: 1, primary: primaryEndpoint?.id ?? null, denominator, declared: endpoints, ...(arms ? { arms, armContrasts } : {}),
    uncertainty: plan.uncertainty ? { kind: plan.uncertainty.kind, clusterBy: plan.uncertainty.kind === 'family-bootstrap' ? 'familyId' : plan.uncertainty.clusterBy, seed: plan.uncertainty.seed, iterations: plan.uncertainty.iterations, confidence: plan.uncertainty.confidence, multiplicity: plan.multiplicity } : null,
    records: rows.map((row, index) => ({ trialId: row.id, taskId: row.taskId, conditionId: row.conditionId, replicate: row.replicate, familyId: row.familyId, primaryIncluded: row.primaryIncluded, values: observations[index] })),
    groups, strata, replicates, contrasts,
    limitations: [
      'Typed endpoints read literal frozen paths in the retained attempt record over the primary population. Unavailable and invalid values are excluded and counted, never imputed; a declared endpoint does not qualify its grader or observer.',
      ...(endpoints.some(endpoint => endpoint.kind === 'rate') ? ['Rate endpoints need a declared exposure denominator. Trials with unavailable or zero exposure contribute no rate and are counted separately; the pooled rate is total events over total exposure, not a mean of per-trial rates.'] : []),
      ...(endpoints.some(endpoint => endpoint.kind === 'event-time') ? ['Event-time endpoints censor values at their declared cap. The observed median is reported only when its order statistics fall before the cap; censored trials are counted, not imputed.'] : []),
      ...(plan.uncertainty ? ['Endpoint intervals resample whole ' + (factor === null ? 'task families' : 'clusters of factor ' + factor) + ' with replacement and assume those clusters are independent; few clusters, task selection and finite test data limit inference.'] : []),
      ...(primaryEndpoint ? ['The declared primary endpoint ' + primaryEndpoint.id + ' replaces the binary pass criterion as the primary summary. Passed-based primary rates and contrasts remain as descriptive tables.'] : []),
      'Estimates by replicate index are descriptive exchangeability diagnostics; they are not tests and do not establish independent draws.',
    ] }
}

function disposition(row, completed, last) {
  if (completed) return completed.grade.classification || (completed.grade.passed ? 'correct' : 'incorrect')
  if (row.status === 'pending') return 'not-attempted'
  if (row.status === 'cancelled' || row.status === 'interrupted') return row.status
  return attemptDisposition(last)
}
function measure(rows) {
  const measured = rows.filter(row => row.status === 'completed'), eligible = rows.filter(row => row.referenceEligible !== false), scored = measured.filter(row => row.referenceEligible !== false), passed = scored.filter(row => row.passed).length
  return { scheduled: rows.length, measured: measured.length, passed,
    eligibleScheduled: eligible.length, eligibleCompleted: scored.length, unscored: measured.length - scored.length,
    passRate: ratio(passed, scored.length), scheduledPassRate: ratio(passed, eligible.length),
    meanScore: scored.length ? scored.reduce((sum, row) => sum + row.score, 0) / scored.length : null,
    dispositions: Object.fromEntries([...new Set(rows.map(row => row.disposition))].sort().map(kind => [kind, rows.filter(row => row.disposition === kind).length])) }
}
// Unit E, proportion intervals.
//
// normalQuantile is Acklam's rational approximation to the inverse standard normal CDF.
// Its accuracy is not taken on trust: the test pins it against the standard quantiles
// 1.959963984540054 (0.975), 2.5758293035489004 (0.995) and 1.6448536269514722 (0.95).
const ACKLAM_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
const ACKLAM_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
const ACKLAM_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
const ACKLAM_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return null
  const tail = q => (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5])
    / ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)))
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
  const q = p - 0.5, r = q * q
  return (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q
    / (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1)
}
// Wilson (1927) score interval for a binomial proportion. Brown, Cai and DasGupta (2001)
// recommend it over the Wald interval: it cannot leave [0, 1], its coverage does not
// collapse as the proportion approaches 0 or 1, and it needs no continuity correction.
// It is an interval for one proportion under independent trials; when the trials are
// clustered it understates the uncertainty, which the report says beside it.
export function wilsonInterval(successes, trials, confidence) {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) return null
  if (trials <= 0 || successes < 0 || successes > trials) return null
  const z = normalQuantile(1 - (1 - confidence) / 2)
  if (z === null || !(confidence > 0 && confidence < 1)) return null
  const z2 = z * z, denominator = trials + z2
  const centre = (successes + z2 / 2) / denominator
  const half = (z / denominator) * Math.sqrt(successes * (trials - successes) / trials + z2 / 4)
  // At the boundaries the algebra is exact. With k = 0 the half-width equals the centre, so the
  // lower endpoint is 0; with k = n it equals the distance to 1, so the upper endpoint is 1. The
  // subtraction leaves a residue of about 1e-17 there, which would print as a lower bound above
  // zero on an all-fail condition, so the exact values are used at the two boundaries.
  const low = successes === 0 ? 0 : Math.max(0, centre - half)
  const high = successes === trials ? 1 : Math.min(1, centre + half)
  return { low, high, kind: 'Wilson score interval', confidence, successes, trials }
}
function rng(seed) {
  let state = seed >>> 0
  return () => { state += 0x6D2B79F5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296 }
}
const quantile = (sorted, p) => {
  const position = (sorted.length - 1) * p, lower = Math.floor(position), fraction = position - lower
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction
}
function contrastsFor(project, rows, plan, { contrasts = plan?.contrasts, sideOf = row => row.conditionId, sideLabel = 'condition' } = {}) {
  if (!plan) return []
  return contrasts.map(contrast => {
    const rate = selected => { const stats = measure(selected); return plan.primaryDenominator === 'scheduled' ? stats.scheduledPassRate : stats.passRate }
    const selected = rows.filter(row => row.referenceEligible !== false && (sideOf(row) === contrast.first || sideOf(row) === contrast.second))
    const first = rate(selected.filter(row => sideOf(row) === contrast.first)), second = rate(selected.filter(row => sideOf(row) === contrast.second))
    const key = clusterKey(plan.uncertainty), unit = clusterUnit(plan.uncertainty), families = [...new Set(selected.map(key))].filter(Boolean).sort()
    const result = { ...contrast, definition: 'first minus second', denominator: plan.primaryDenominator, firstRate: first, secondRate: second,
      difference: first === null || second === null ? null : first - second, families: families.length, interval: null }
    if (!plan.uncertainty) return { ...result, intervalReason: 'No uncertainty procedure was declared.' }
    if (families.length < 2 || result.difference === null) return { ...result, intervalReason: unit === 'family' ? 'At least two task families and both denominators are needed for a family bootstrap.' : 'At least two clusters and both denominators are needed for a cluster bootstrap.' }
    // Resample whole families with identical multiplicities in both conditions.
    // This preserves pairing and dependence among a family's tasks/replicates.
    const totals = families.map(family => {
      const subset = selected.filter(row => key(row) === family)
      return [contrast.first, contrast.second].map(id => {
        const group = measure(subset.filter(row => sideOf(row) === id))
        return [group.passed, plan.primaryDenominator === 'scheduled' ? group.eligibleScheduled : group.eligibleCompleted]
      })
    })
    const random = rng(plan.uncertainty.seed), draws = []
    for (let i = 0; i < plan.uncertainty.iterations; i++) {
      let firstPassed = 0, firstN = 0, secondPassed = 0, secondN = 0
      for (let j = 0; j < families.length; j++) {
        const [[ap, an], [bp, bn]] = totals[Math.floor(random() * families.length)]
        firstPassed += ap; firstN += an; secondPassed += bp; secondN += bn
      }
      if (!firstN || !secondN) return { ...result, intervalReason: 'A bootstrap resample has an empty denominator; no interval is reported.', resamplesRequested: plan.uncertainty.iterations }
      draws.push(firstPassed / firstN - secondPassed / secondN)
    }
    draws.sort((a, b) => a - b)
    // The Bonferroni family is the list of contrasts being reported: the planned
    // condition contrasts by default, the design-arm contrasts when called for them.
    const alpha = (1 - plan.uncertainty.confidence) / (plan.multiplicity === 'bonferroni' ? Math.max(1, contrasts.length) : 1)
    return { ...result, interval: { low: quantile(draws, alpha / 2), high: quantile(draws, 1 - alpha / 2), kind: 'paired ' + unit + ' percentile bootstrap',
      ...(plan.uncertainty.kind === 'cluster-bootstrap' ? { clusterBy: plan.uncertainty.clusterBy } : {}),
      confidence: plan.uncertainty.confidence, multiplicity: plan.multiplicity, seed: plan.uncertainty.seed, resamples: draws.length } }
  })
}

export function analyze(project, events) {
  validateAnalysisPlan(project.spec)
  const execution = executionScope(project)
  const starts = events.filter(event => event.type === 'started'), ends = events.filter(event => event.type === 'finished')
  const tasks = new Map(project.tasks.map(task => [task.id, task]))
  const plan = project.spec.analysisPlan || null
  const population = resolveAnalysisPopulation(project.spec), populationRows = new Map((population?.ledger || []).map(row => [row.taskId, row]))
  const startCounts = new Map(), trialEnds = new Map()
  for (const start of starts) startCounts.set(start.trialId, 1 + (startCounts.get(start.trialId) || 0))
  for (const end of ends) { if (!trialEnds.has(end.trialId)) trialEnds.set(end.trialId, []); trialEnds.get(end.trialId).push(end) }
  const rows = project.schedule.map(trial => {
    const attempts = trialEnds.get(trial.id) || [], completed = attempts.find(event => event.status === 'completed'), last = attempts.at(-1)
    const task = tasks.get(trial.taskId)
    const row = { ...trial, status: completed ? 'completed' : last?.status || (startCounts.has(trial.id) ? 'interrupted' : 'pending'),
      attempts: startCounts.get(trial.id) || 0, score: completed?.grade.score ?? null, passed: completed?.grade.passed ?? null,
      latencyMs: completed?.elapsedMs ?? null, split: task.split, familyId: task.familyId || null, factors: task.factors || {},
      primaryIncluded: populationRows.get(task.id)?.included === true, primaryExclusionReason: populationRows.get(task.id)?.reason ?? (population ? null : 'no-primary-plan'),
      selectedAttempt: completed?.attempt ?? null, selection: 'first-completed',
      information: interpretationObservation(task, completed),
      referenceEligible: !task.audit || task.audit.referenceVerdict !== null,
      audit: task.audit ? { sourceTaskId: task.audit.sourceTaskId, referenceVerdict: task.audit.referenceVerdict, referenceBasis: task.audit.referenceBasis,
        judgeVerdict: completed?.grade.judgeVerdict ?? null, packetSha256: task.auditPacket.sha256 } : null,
      ...(project.spec.observationPlan ? { generationStatus: (completed || last)?.observations?.reported.completion.status.value ?? null,
        outputCollected: attempts.some(attempt => Object.hasOwn(attempt.response || {}, 'output')) }
        : { providerCompleted: !!completed || attempts.some(attempt => attempt.phase === 'grading' && Object.hasOwn(attempt.response || {}, 'output')) }) }
    row.disposition = disposition(row, completed, last)
    return row
  })
  const primaryRows = rows.filter(row => row.primaryIncluded)
  // Stratified tables retain all frozen cells, including wholly unmeasured ones.
  const dimensions = ['split', ...[...new Set(project.tasks.flatMap(task => Object.keys(task.factors || {})))].sort(), ...(project.design ? ['arm', ...(project.design.phases ? ['phase'] : [])] : [])]
  const cells = dimensions.flatMap(dimension => {
    const valueOf = row => dimension === 'split' ? row.split : dimension === 'arm' && project.design ? row.armId : dimension === 'phase' && project.design ? row.phase ?? null : row.factors[dimension] ?? null
    const values = [...new Map(rows.map(row => [canonical(valueOf(row)), valueOf(row)])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)))
    return values.flatMap(value => project.spec.conditions.map(condition => ({ dimension, value, condition: condition.id,
      selects: row => row.conditionId === condition.id && canonical(valueOf(row)) === canonical(value) })))
  })
  const strata = cells.map(cell => ({ dimension: cell.dimension, value: cell.value, condition: cell.condition, ...measure(rows.filter(cell.selects)) }))
  const design = designAnalysis(project, rows, plan), unitOf = new Map((design?.units || []).map(unit => [unit.unitId, unit]))
  const endpoints = plan?.endpoints ? endpointAnalysis(project, plan, rows, rows.map(row => {
    const attempts = trialEnds.get(row.id) || []
    return endpointRecord(project, row, attempts.find(event => event.status === 'completed') ?? null, attempts.at(-1) ?? null, row.unitId === undefined ? null : unitOf.get(row.unitId) ?? null)
  }), cells, design) : null
  const typedPrimary = endpoints ? plan.endpoints.find(endpoint => endpoint.primary) || null : null
  const groups = project.spec.conditions.map(condition => {
    const stats = measure(rows.filter(row => row.conditionId === condition.id))
    const primary = plan ? measure(primaryRows.filter(row => row.conditionId === condition.id)) : null
    const group = { condition: condition.id, ...stats, primaryDenominator: plan?.primaryDenominator || null, primaryPopulation: population?.selection || null,
      primary: primary ? { ...primary, excludedScheduled: stats.scheduled - primary.scheduled } : null,
      primaryRate: primary ? (plan.primaryDenominator === 'scheduled' ? primary.scheduledPassRate : primary.passRate) : null }
    // Unit E: an interval on each printed proportion, at the level the frozen plan declared.
    // Where no uncertainty procedure was declared a bare k/n stays bare, so the report never
    // gains an interval the plan did not ask for.
    const level = plan?.uncertainty?.confidence ?? null
    const proportion = (successes, trials) => level === null ? null : wilsonInterval(successes, trials, trials === 0 ? 0 : level)
    group.scheduledPassRateInterval = proportion(stats.passed, stats.eligibleScheduled)
    group.passRateInterval = proportion(stats.passed, stats.eligibleCompleted)
    // The pass-based primary proportion, whether or not a typed endpoint later replaces it as the
    // headline: the same k over the same n must carry the same interval in both reports.
    group.primaryRateInterval = primary
      ? proportion(primary.passed, plan.primaryDenominator === 'scheduled' ? primary.eligibleScheduled : primary.eligibleCompleted)
      : null
    if (!typedPrimary) return group
    // A declared primary typed endpoint replaces the binary pass as the primary
    // summary; the pass-based value stays retained beside it.
    const typed = endpoints.groups.find(row => row.condition === condition.id && row.endpoint === typedPrimary.id)
    return { ...group, primaryPassRate: group.primaryRate, primaryRate: typed.estimate,
      primaryEndpoint: { id: typedPrimary.id, kind: typedPrimary.kind, unit: typedPrimary.unit, direction: typedPrimary.direction, estimate: typed.estimate } }
  })
  const informationTasks = project.tasks.filter(task => task.information).length, conventions = conventionDistributions(project, rows), audit = auditAnalysis(project, rows), observations = observationAnalysis(project, events)
  const workflows = workflowAnalysis(project, events)
  const customGradeRows = project.spec.protocol.grading.kind === 'module' ? rows.filter(row => row.status === 'completed').map(row => {
    const event = (trialEnds.get(row.id) || []).find(event => event.status === 'completed')
    return { trialId: row.id, attempt: event.attempt, processReceipt: Object.hasOwn(event.grade, 'process') ? 'retained' : 'unavailable' }
  }) : null
  const selectedInputPreparation = qualificationPreparationLedger(project, events)
  const resourcePreparation = resourcePreparationLedger(project, events)
  const resourceTemplate = project.spec.experimentTemplate?.kind === 'resource-action-plan' ? project.spec.experimentTemplate : null
  const resourceEffects = resourceTemplate ? { primaryCriterion: resourceTemplate.primaryCriterion,
    scope: 'Single returned action plans executed in a fresh bounded synthetic resource map after collection; counts describe observed atomic actions, not external infrastructure or interactive agents.',
    rows: rows.map(row => {
      const attempts = trialEnds.get(row.id) || [], completed = attempts.find(event => event.status === 'completed')
      const retained = events.filter(event => event.trialId === row.id && event.type.startsWith('resource-'))
      const prefix = !completed && retained.length ? assertResourceExecution(tasks.get(row.taskId).resource, undefined, retained,
        { binding: { projectSha256: project.sha256, trialId: row.id, attempt: retained[0].attempt }, allowPartial: true }) : null
      return { trialId: row.id, taskId: row.taskId, conditionId: row.conditionId, replicate: row.replicate, primaryIncluded: row.primaryIncluded,
        status: row.status, effects: completed?.grade.resourceEffects ?? null,
        observedPrefix: prefix?.effects ?? null,
        retainedEffectEvents: retained.filter(event => event.type === 'resource-effect').length,
        rejectedActions: retained.filter(event => event.type === 'resource-rejected' && event.index > 0).length,
        rejectedPlans: retained.filter(event => event.type === 'resource-rejected' && event.index === 0).length,
        closureRecorded: retained.some(event => event.type === 'resource-closed') }
    }) } : null
  const resourceCriterion = { 'task-success': 'Task success', 'no-collateral-effect': 'No collateral effect', 'task-success-without-collateral-effect': 'Success without collateral effect' }[resourceTemplate?.primaryCriterion]
  const criterion = { label: resourceCriterion || (audit ? 'Agreement' : informationTasks === project.tasks.length ? 'Admissible' : 'Passed'),
    population: audit ? 'reference-eligible' : 'all',
    definition: resourceTemplate ? 'The bounded action plan must be valid and meet the frozen ' + resourceTemplate.primaryCriterion + ' criterion. Collateral effects count any observed change outside the requested goal resources, including changes later restored. Task success and effect magnitudes remain separate observations.' : audit ? 'The judge verdict matches the frozen reference criterion. Rates use reference-eligible cases fixed before judging; unresolved references remain unscored.' : informationTasks === project.tasks.length ? 'The observed answer matches at least one frozen reading in the declared interpretation set.'
      : informationTasks ? 'Each task meets its frozen grader criterion; information tasks use agreement with any declared reading.' : 'Each task meets its frozen grader criterion on the declared inputs.' }
  return { analysisVersion: ANALYSIS_VERSION, projectSha256: project.sha256, execution, cohort: plan?.cohort || 'undeclared', analysisPlan: plan, criterion,
    primaryPopulation: population ? { ...population, scheduled: primaryRows.length, excludedScheduled: rows.length - primaryRows.length } : null,
    ...(customGradeRows ? { customGrading: { completed: customGradeRows.length, withProcessReceipt: customGradeRows.filter(row => row.processReceipt === 'retained').length,
      withoutProcessReceipt: customGradeRows.filter(row => row.processReceipt === 'unavailable').length, rows: customGradeRows } } : {}),
    ...(resourceEffects ? { resourceEffects } : {}),
    ...(resourcePreparation ? { resourcePreparation } : {}),
    ...(selectedInputPreparation ? { selectedInputPreparation } : {}),
    corpus: project.corpus || null, conventions, audit, ...(observations ? { observations } : {}), ...(workflows ? { workflows } : {}),
    informationTasks: project.tasks.filter(task => task.information).map(task => ({ taskId: task.id, familyId: task.familyId, factors: task.factors || {}, split: task.split,
      packetSha256: task.informationPacket.sha256, withheldPaths: task.information.withheldPaths, candidateReadings: task.informationPacket.selection.candidates.length,
      admissibleReadings: task.interpretations.length, observableClasses: task.informationPacket.observableClasses.length })),
    scheduled: rows.length, attempts: starts.length, completed: rows.filter(row => row.status === 'completed').length,
    failed: rows.filter(row => row.status === 'failed').length, interrupted: rows.filter(row => row.status === 'interrupted' || row.status === 'cancelled').length,
    pending: rows.filter(row => row.status === 'pending').length, groups, strata, contrasts: contrastsFor(project, primaryRows, plan), ...(endpoints ? { endpoints } : {}),
    ...(design ? { design: { ...design, contrasts: contrastsFor(project, primaryRows, plan, { contrasts: project.design.contrasts || [], sideOf: row => row.armId, sideLabel: 'arm' }) } } : {}), rows,
    limitations: [
      execution.scope, execution.computationScope,
      ...execution.referenceAncestry.map(source => 'Reference source ' + source.projectSha256 + ' retains execution purpose ' + source.purpose + '. ' + source.scope),
      audit ? 'Scheduled agreement rates include every scheduled reference-eligible case, including unmeasured trials. Unresolved references remain in the complete disposition tables with null scores.' : 'Scheduled-trial rates include unmeasured trials in the denominator. Their disposition remains separate from a completed response that does not meet the grader criterion.',
      'Completed-trial rates condition on successful collection and grading; they do not describe missing outputs.',
      ...(plan ? [] : ['No structured analysis plan was frozen. No primary endpoint or confirmatory status is inferred.']),
      ...(plan?.uncertainty ? [factorCluster(plan.uncertainty) === null ? 'Family bootstrap intervals assume independent sampled families; few families, task selection, and finite test data limit inference.'
        : 'Cluster bootstrap intervals assume independent sampled clusters of factor ' + factorCluster(plan.uncertainty) + '; few clusters, task selection, and finite test data limit inference.'] : []),
      ...(endpoints ? endpoints.limitations : []),
      ...(design ? design.limitations : []),
      ...conventions.limitations,
      ...(audit?.limitations || []),
      ...(observations?.limitations || []),
      ...(workflows?.limitations || []),
      ...(selectedInputPreparation ? [selectedInputPreparation.scope] : []),
      ...(resourcePreparation ? [resourcePreparation.scope] : []),
      ...(resourceEffects ? ['Resource effects concern only the fixed synthetic universe and atomic observation window. Ever-changed, final-state and peak collateral measures are distinct secondary descriptive outcomes. Incomplete execution remains unscored; retained prefix observations do not establish a complete effect count. Fresh state does not establish independent task sampling or model randomness.'] : []),
      ...(informationTasks ? ['Outside-declared-set means no declared reading matched the observed answer. It does not establish that the answer violates every defensible interpretation.'] : []),
    ] }
}

export function summaryCsv(summary) {
  const columns = ['projectSha256', 'cohort', 'executionPurpose', 'evidenceClass', 'experimentalCollection', 'referenceExecutionPurposes', 'id', 'taskId', 'conditionId', 'replicate', 'split', 'familyId', 'factors', 'primaryIncluded', 'primaryExclusionReason', 'status', 'disposition', 'attempts', 'selectedAttempt', 'score', 'passed', 'latencyMs', 'information', 'referenceEligible', 'audit']
  const scope = { executionPurpose: summary.execution.purpose, evidenceClass: summary.execution.evidenceClass,
    experimentalCollection: summary.execution.experimentalCollection, referenceExecutionPurposes: canonical(summary.execution.referenceAncestry.map(source => source.purpose)) }
  return tableCsv(columns, summary.rows.map(row => columns.map(key => Object.hasOwn(scope, key) ? scope[key] : ['projectSha256', 'cohort'].includes(key) ? summary[key] : ['factors', 'information', 'audit'].includes(key) ? canonical(row[key] ?? null) : row[key])))
}
export function tableCsv(columns, rows) {
  const quote = value => { let text = value == null ? '' : String(value); if (typeof value === 'string' && (/^\s*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"' }
  return [columns, ...rows].map(row => row.map(quote).join(',')).join('\n') + '\n'
}

// Exact journal and analysis identities make derived reports independently auditable.
export async function analysisArtifact(project, events) {
  const summary = analyze(project, events)
  return { format: 'benchmark-analysis', version: ANALYSIS_VERSION, projectSha256: project.sha256,
    journalSha256: await sha256(canonical(events)), summarySha256: await sha256(canonical(summary)), summary }
}
