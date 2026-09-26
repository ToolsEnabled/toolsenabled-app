// Typed experiment generators. An investigator recipe produces executable
// apparatus; generated criteria and private packets cannot be edited separately.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { compileResourcePacket, validateResourceFixture } from './resource-effects.mjs'

export const EXPERIMENT_TEMPLATE_VERSION = 1
export const EXPERIMENT_TEMPLATE_REGISTRY = Object.freeze({
  'resource-action-plan': Object.freeze({ version: 1, label: 'Resource action plan', domain: 'generic', interaction: 'single-plan' }),
})
export const TEMPLATE_LIMITS = Object.freeze({ cases: 32, resources: 32, actions: 32, valueBytes: 256, fixtureBytes: 16384, instructionBytes: 4096, evidenceBytes: 16 * 1024 * 1024 })
// Invocation policy belongs to the pinned runtime, outside the generated
// template contract so previously frozen schema-1 packets keep their identity.
export const RESOURCE_PREPARATION_LIMITS = Object.freeze({ timeoutMs: 60000 })
export function resourcePreparationLedger(project, events) {
  if (project.spec.protocol.grading.kind !== 'resource-action-plan') return null
  const terminals = events.filter(event => ['template-qualified', 'template-requalified', 'template-preparation-failed'].includes(event.type))
  const rows = events.filter(event => event.type === 'template-preparation-started' || terminals.includes(event) && event.preparationSeq === undefined).map(event => {
    const modern = event.type === 'template-preparation-started'
    const terminal = modern ? terminals.find(row => row.preparationSeq === event.seq) : event
    const status = !terminal ? 'open' : terminal.type === 'template-preparation-failed' ? terminal.status || 'failed'
      : terminal.type === 'template-qualified' ? 'qualified' : 'requalified'
    return { startSeq: modern ? event.seq : null, terminalSeq: terminal?.seq ?? null, at: event.at, status,
      legacy: !modern, timeoutMs: modern ? event.timeoutMs : null, reservedMs: modern ? event.reservedMs : null,
      elapsedMs: modern ? terminal?.elapsedMs ?? null : null,
      budgetChargeMs: terminal?.budgetChargeMs ?? event.reservedMs,
      chargeBasis: !terminal || status === 'interrupted' ? 'reserved' : 'measured',
      settled: !!terminal && status !== 'interrupted', reason: terminal?.reason ?? null,
      proofSha256: terminal?.record?.sha256 ?? terminal?.recordSha256 ?? null }
  })
  const missingElapsed = rows.filter(row => row.elapsedMs === null).length
  const knownElapsedMs = rows.reduce((sum, row) => sum + (row.elapsedMs ?? 0), 0)
  return { rows, preparations: rows.length, qualified: rows.filter(row => ['qualified', 'requalified'].includes(row.status)).length,
    legacy: rows.filter(row => row.legacy).length, open: rows.filter(row => row.status === 'open').length,
    interrupted: rows.filter(row => row.status === 'interrupted').length, missingElapsed, knownElapsedMs,
    elapsedMs: missingElapsed ? null : knownElapsedMs, budgetChargeMs: rows.reduce((sum, row) => sum + row.budgetChargeMs, 0),
    maxPreparations: project.schedule.length + 1, limits: RESOURCE_PREPARATION_LIMITS,
    scope: 'Resource preparation owns only bounded in-memory maps. Modern execution records intent before conformance; explicit recovery charges the full reservation without inventing elapsed time, then permits fresh conformance only within the remaining cumulative budget and preparation count. Legacy terminal-only measured charges remain usable without inferring a prior durable intent or separate elapsed measurement.' }
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : canonical(value)).length
const copy = value => JSON.parse(canonical(value))
const own = (value, key) => Object.hasOwn(value, key)
const fields = (value, allowed, label) => {
  invariant(object(value), label + ' must be an object.')
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  invariant(!unknown.length, label + ' has unsupported fields: ' + unknown.join(', ') + '.')
}
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const text = value => typeof value === 'string' && value.trim().length > 0
const criterion = value => ['task-success', 'no-collateral-effect', 'task-success-without-collateral-effect'].includes(value)

function validateRecipe(recipe) {
  fields(recipe, ['kind', 'version', 'primaryCriterion', 'maxActions', 'cases'], 'Experiment template recipe')
  invariant(recipe.kind === 'resource-action-plan' && recipe.version === 1, 'Choose a supported version of the resource-action-plan experiment template.')
  invariant(criterion(recipe.primaryCriterion), 'Choose task success, no collateral effect, or task success without collateral effect as the primary criterion.')
  invariant(integer(recipe.maxActions, 1, TEMPLATE_LIMITS.actions), 'The resource template supports 1–32 actions per returned plan.')
  invariant(Array.isArray(recipe.cases) && recipe.cases.length > 0 && recipe.cases.length <= TEMPLATE_LIMITS.cases, 'Declare 1–32 resource cases.')
  const identities = new Set(), families = new Map()
  for (const row of recipe.cases) {
    fields(row, ['id', 'familyId', 'split', 'instruction', 'resources', 'goals'], 'Resource case')
    invariant(ID.test(row.id) && !identities.has(row.id), 'Resource cases need distinct lowercase identifiers.'); identities.add(row.id)
    invariant(ID.test(row.familyId) && ['development', 'held-out'].includes(row.split), row.id + ': declare its task family and development or held-out split.')
    invariant(!families.has(row.familyId) || families.get(row.familyId) === row.split, row.familyId + ': a resource family cannot cross development and held-out splits.'); families.set(row.familyId, row.split)
    invariant(text(row.instruction) && bytes(row.instruction) <= TEMPLATE_LIMITS.instructionBytes, row.id + ': supply a task instruction within 4096 UTF-8 bytes.')
    invariant(Array.isArray(row.resources) && row.resources.length > 0 && row.resources.length <= TEMPLATE_LIMITS.resources, row.id + ': declare 1–32 resources.')
    for (const resource of row.resources) fields(resource, ['id', 'value', 'visible', 'writable'], 'Resource')
    invariant(Array.isArray(row.goals) && row.goals.length > 0 && row.goals.length <= recipe.maxActions, row.id + ': the nonempty generated reference plan must fit maxActions.')
    for (const goal of row.goals) fields(goal, goal?.op === 'delete' ? ['resourceId', 'op'] : ['resourceId', 'op', 'value'], 'Resource goal')
    validateResourceFixture({ resources: row.resources, goals: row.goals })
    invariant(bytes({ resources: row.resources, goals: row.goals }) <= TEMPLATE_LIMITS.fixtureBytes, row.id + ': the canonical resource fixture exceeds 16 KiB.')
    const intended = new Set(row.goals.map(goal => goal.resourceId))
    invariant(recipe.primaryCriterion === 'task-success' || row.resources.some(resource => resource.writable && !intended.has(resource.id)),
      row.id + ': add a writable non-goal resource to make the collateral-effect criterion testable, or choose task-success.')
  }
  return recipe
}

function limitsFor(recipe) {
  // Values can be escaped once in a JSON plan and again in its wire envelope.
  const maxResponseBytes = 16384 + recipe.maxActions * (512 + 12 * TEMPLATE_LIMITS.valueBytes)
  return { ...TEMPLATE_LIMITS, maxActions: recipe.maxActions, maxResponseBytes }
}
function evidenceBudget(recipe, { conditions = 1, replicates = 1, specificationBytes = 0 } = {}) {
  const limits = limitsFor(recipe)
  // A qualification is retained in the journal, evidence.json and its report
  // artifact. Each control repeats its output in preparation, its grade in
  // closure, and a complete snapshot after every effect. Include pretty JSON
  // whitespace explicitly instead of treating a fixed allowance as a bound on
  // an investigator-selected collection of controls.
  const controlBytes = (resourceIds, actionCount, valueBytes, outputBytes) => {
    const stateBytes = resourceIds.reduce((sum, id) => sum + 512 + id.length + 6 * valueBytes, 128)
    const gradeBytes = 4096 + 8 * resourceIds.reduce((sum, id) => sum + id.length + 8, 0)
    return 3 * (4096 + 3 * outputBytes + (actionCount + 2) * (stateBytes + 1536)
      + actionCount * (512 + 6 * valueBytes) + 2 * gradeBytes)
  }
  // The registered fixed suite has 12 controls, at most five effects, five
  // resources and <=64-byte strings. Reserve a separate 32 KiB packet per
  // control (also in three copies), well above the fixed packet representation.
  const fixedConformanceBytes = 12 * (3 * 32768 + controlBytes(Array(5).fill('x'.repeat(64)), 5, 64, 2048 + 5 * (256 + 6 * 64)))
  const cases = recipe.cases.map(row => {
    // Include maximum-sized replacement values even if initial values are tiny.
    const stateBytes = row.resources.reduce((sum, resource) => sum + 512 + resource.id.length + 6 * TEMPLATE_LIMITS.valueBytes, 128)
    const gradeBytes = 4096 + 8 * row.resources.reduce((sum, resource) => sum + resource.id.length + 8, 0)
    // Wire response: journal, evidence and durable response file. Raw plan:
    // preparation in journal and evidence. Intents retain action values too.
    const perTrialBytes = 16384 + 5 * limits.maxResponseBytes + 2 * (recipe.maxActions + 2) * (stateBytes + 1536)
      + 2 * recipe.maxActions * (512 + 6 * TEMPLATE_LIMITS.valueBytes) + 6 * gradeBytes
    const outside = row.resources.some(resource => resource.writable && !row.goals.some(goal => goal.resourceId === resource.id))
    const controls = [{ id: 'reference', actions: row.goals.length }, { id: 'no-op', actions: 0 }]
    for (const [id, extra] of [['collateral', 1], ['repair', 2]]) if (outside && row.goals.length + extra <= recipe.maxActions) controls.push({ id, actions: row.goals.length + extra })
    const conformanceControls = controls.map(control => ({ ...control, bytes: controlBytes(row.resources.map(resource => resource.id), control.actions,
      TEMPLATE_LIMITS.valueBytes, 2048 + control.actions * (256 + 6 * TEMPLATE_LIMITS.valueBytes)) }))
    const conformanceBytes = 4096 + conformanceControls.reduce((sum, control) => sum + control.bytes, 0)
    return { id: row.id, trials: conditions * replicates, perTrialBytes, totalBytes: perTrialBytes * conditions * replicates, conformanceControls, conformanceBytes }
  })
  const scheduledTrials = cases.reduce((sum, row) => sum + row.trials, 0), maxQualificationReceipts = scheduledTrials + 1
  const compactQualificationBytes = 3 * 1024 * maxQualificationReceipts
  const conformanceBytes = fixedConformanceBytes + compactQualificationBytes + cases.reduce((sum, row) => sum + row.conformanceBytes, 0)
  const estimatedBytes = 512 * 1024 + conformanceBytes + 8 * bytes(recipe) + 2 * specificationBytes + cases.reduce((sum, row) => sum + row.totalBytes, 0)
  invariant(Number.isSafeInteger(estimatedBytes) && estimatedBytes <= limits.evidenceBytes,
    'This resource design exceeds the conservative 16 MiB evidence budget, including every selected-case preflight control, three qualification copies, retained trial responses, plans, grades and state observations. Reduce cases, resources, actions, conditions or replicates before freezing.')
  return { limitBytes: limits.evidenceBytes, estimatedBytes, scheduledTrials, cases, fixedConformanceBytes, compactQualificationBytes, conformanceBytes,
    fullQualificationReceipts: 1, maxQualificationReceipts,
    basis: 'Worst-case escaped resource values; three response and two prepared-plan/state copies per trial, with intent values and repeated grades; three copies of one full fixed and selected-case conformance receipt with pretty-print allowances; bounded compact requalification receipts; generated specification and report allowance. Collection must enforce response and journal limits and bind fresh requalification to the retained full proof.' }
}

export function validateExperimentTemplate(spec) {
  if (spec?.experimentTemplate === undefined) return null
  const recipe = validateRecipe(spec.experimentTemplate)
  fields(spec, ['schemaVersion', 'executionPlan', 'id', 'name', 'version', 'domain', 'requireReview', 'catalog', 'tasks', 'conditions', 'protocol', 'inputs', 'environment', 'analysisPlan', 'observationPlan', 'decisions', 'reviews', 'taskReviews', 'runtimeSources', 'experimentTemplate', 'citation', 'generator', 'pricing'], 'Resource template study')
  invariant(spec.domain === 'generic', 'Resource action plans use the generic experiment domain.')
  fields(spec.protocol, ['seed', 'replicates', 'maxAttemptsPerTrial', 'maxTotalAttempts', 'timeoutMs', 'maxDurationMs', 'grading', 'selection', 'stopping', 'analysis'], 'Resource template protocol')
  fields(spec.protocol.grading, ['kind'], 'Resource template grading')
  invariant(spec.protocol.grading.kind === 'resource-action-plan', 'Use the generated resource-action-plan grader for this template; authored expected answers and custom graders cannot replace it.')
  invariant(spec.protocol.maxAttemptsPerTrial === 1, 'Resource action plans allow exactly one attempt per scheduled trial; interrupted effects cannot be redrawn.')
  invariant(integer(spec.protocol.replicates, 1, 100), 'Declare 1–100 replicates for the resource design.')
  invariant(Array.isArray(spec.conditions) && spec.conditions.length > 0 && spec.conditions.length <= 32, 'Declare 1–32 resource collection conditions.')
  invariant(Array.isArray(spec.tasks) && spec.tasks.every(task => !own(task, 'information') && !own(task, 'audit')), 'Resource templates cannot mix information or judge-audit tasks.')
  fields(spec.analysisPlan, ['version', 'cohort', 'primaryDenominator', 'primaryPopulation', 'rationale', 'contrasts', 'multiplicity', 'uncertainty', 'endpoints'], 'Resource template analysis plan')
  invariant(spec.analysisPlan.version === 1 && own(spec.analysisPlan, 'primaryPopulation') && spec.analysisPlan.primaryPopulation !== undefined,
    'Declare an explicit primary population for the generated resource experiment.')
  invariant(spec.analysisPlan.primaryDenominator === 'scheduled', 'Resource template primary rates include every scheduled trial in the declared primary population.')
  invariant(spec.analysisPlan.uncertainty === null || spec.analysisPlan.uncertainty?.kind === 'family-bootstrap', 'Resource templates support descriptive analysis or family-bootstrap rate contrasts.')
  if (spec.environment !== undefined) {
    fields(spec.environment, ['node', 'nodeVersion', 'dependencies', 'instructions'], 'Resource template environment')
    invariant(spec.environment.dependencies === undefined || Array.isArray(spec.environment.dependencies) && spec.environment.dependencies.length === 0,
      'The generated resource runtime has no external dependencies; shared, persistent and custom execution environments are unsupported.')
  }
  invariant(Array.isArray(spec.inputs) && spec.inputs.length === 0, 'Resource template fixtures are generated from fields; external inputs and executable attachments are unsupported in this profile.')
  const responseLimit = limitsFor(recipe).maxResponseBytes
  for (const condition of spec.conditions) {
    fields(condition, ['id', 'label', 'model', 'adapter', 'collection'], 'Resource collection condition')
    invariant(object(condition.adapter) && ['replay', 'http'].includes(condition.adapter.kind), 'Resource templates support recorded responses or an HTTPS public request; local commands, modules and interactive agents are unsupported.')
    if (condition.adapter.kind === 'replay') {
      fields(condition.adapter, ['kind', 'responses', 'mode'], 'Resource replay adapter')
      invariant(condition.adapter.mode === undefined || ['output', 'envelope'].includes(condition.adapter.mode), 'Resource replay mode must be output or envelope.')
      invariant(object(condition.adapter.responses) && Object.keys(condition.adapter.responses).length === recipe.cases.length
        && recipe.cases.every(row => own(condition.adapter.responses, row.id)), 'Supply exactly one recorded response per generated resource case.')
      invariant(condition.adapter.mode !== 'envelope' || object(spec.observationPlan), 'Resource replay envelopes require an accounting plan.')
      for (const response of Object.values(condition.adapter.responses)) invariant(bytes(condition.adapter.mode === 'envelope' ? response : { output: response }) <= responseLimit,
        'A recorded resource response exceeds the generated response byte limit.')
    } else {
      fields(condition.adapter, ['kind', 'url', 'credentialEnv'], 'Resource HTTPS adapter')
      let url; try { url = new URL(condition.adapter.url) } catch {}
      invariant(url?.protocol === 'https:' && !url.username && !url.password, 'Resource collection needs an HTTPS URL without embedded credentials.')
      invariant(object(spec.observationPlan) && object(condition.collection), 'HTTPS resource collection requires accounting and explicit public-request controls.')
      const override = spec.observationPlan.overrides?.[condition.id] || {}
      invariant((override.identity || spec.observationPlan.identity)?.policy === 'require-match' && (override.completion || spec.observationPlan.completion)?.policy === 'require-complete',
        'HTTPS resource collection requires matching reported identity and complete generation; these checks are not provider authentication.')
      invariant(condition.collection.comparisonUnit === 'model', 'The single-plan HTTPS profile compares requested model responses, not an opaque interactive agent system.')
    }
    if (condition.collection !== undefined) {
      fields(condition.collection, ['comparisonUnit', 'instructions', 'tools', 'contextConstruction', 'sessionIsolation'], 'Resource collection controls')
      invariant(['model', 'apparatus'].includes(condition.collection.comparisonUnit) && Array.isArray(condition.collection.tools) && condition.collection.tools.length === 0,
        'Resource single-plan collection exposes no tools; trusted resource execution happens after the response is retained.')
      invariant(text(condition.collection.contextConstruction) && text(condition.collection.sessionIsolation), 'Describe the public request and fresh-request collection boundary.')
      fields(condition.collection.instructions, ['system', 'developer'], 'Resource requested instructions')
      invariant(['system', 'developer'].every(key => own(condition.collection.instructions, key) && (condition.collection.instructions[key] === null || typeof condition.collection.instructions[key] === 'string')),
        'Declare exact system and developer instructions, using null when absent.')
    }
  }
  return evidenceBudget(recipe, { conditions: spec.conditions.length, replicates: spec.protocol.replicates, specificationBytes: bytes(spec) })
}

function generatedControls(packet) {
  const reference = packet.referencePlan, intended = new Set(packet.goals.map(goal => goal.resourceId))
  const collateral = packet.resources.find(resource => resource.writable && !intended.has(resource.id))
  const protectedResource = packet.resources.find(resource => !resource.writable)
  const different = resource => resource.value === 'resource-control-value' ? 'resource-control-alternate' : 'resource-control-value'
  const rows = [{ id: 'reference', applicable: true, reason: null, plan: copy(reference) }, { id: 'empty', applicable: true, reason: null, plan: { actions: [] } }]
  for (const [id, extra] of [['collateral', 1], ['repair', 2]]) {
    const reason = !collateral ? 'No writable non-goal resource exists in this case.' : reference.actions.length + extra > packet.maxActions ? 'This control would exceed the frozen action budget.' : null
    const actions = collateral ? [{ id: 'control-collateral', op: 'set', resourceId: collateral.id, value: different(collateral) },
      ...(extra === 2 ? [{ id: 'control-restore', op: 'set', resourceId: collateral.id, value: collateral.value }] : [])] : []
    rows.push({ id, applicable: reason === null, reason, plan: reason ? null : { actions: [...copy(reference.actions), ...actions] } })
  }
  rows.push({ id: 'protected', applicable: !!protectedResource, reason: protectedResource ? null : 'No read-only resource exists in this case.',
    plan: protectedResource ? { actions: [{ id: 'control-protected', op: 'set', resourceId: protectedResource.id, value: different(protectedResource) }] } : null })
  let unknown = 'unregistered-resource'
  for (let index = 0; packet.resources.some(resource => resource.id === unknown); index++) unknown = 'unregistered-resource-' + index
  rows.push({ id: 'unknown-resource', applicable: true, reason: null, plan: { actions: [{ id: 'control-unknown', op: 'set', resourceId: unknown, value: 'resource-control-value' }] } })
  rows.push({ id: 'invalid-operation', applicable: true, reason: null, plan: { actions: [{ id: 'control-invalid', op: 'write', resourceId: packet.resources[0].id, value: 'resource-control-value' }] } })
  return rows
}

export async function materializeExperimentTemplate(recipe) {
  validateRecipe(recipe)
  const generatedBudget = evidenceBudget(recipe), recipeSha256 = await sha256(canonical(recipe))
  const catalog = [{ id: 'resource-action-task', version: '1', kind: 'atom', role: 'node',
    text: '{{instruction}}\n\nReturn one JSON object with an actions array. Every action needs a unique id, an op (set or delete), and a resourceId. A set also needs a string value. Use at most {{maxActions}} actions. Resource identifiers are logical names, not filesystem paths. The host executes the returned plan once in a fresh synthetic resource store. Complete the stated goals without changing other resources.\n\nVisible initial resources:\n{{resources}}\n\nRequired goals:\n{{goals}}\n\nExact action contract:\n{{actionContract}}\n\nExecution limits:\n{{limits}}',
    parameters: { caseId: '', instruction: '', maxActions: 1, resources: '[]', goals: '[]', actionContract: '{}', limits: '{}' },
    semantics: { kind: 'resource-action-plan', caseId: '{{caseId}}' } }]
  const tasks = [], cases = []
  for (const row of recipe.cases) {
    const packet = await compileResourcePacket({ resources: copy(row.resources), goals: copy(row.goals) }, { caseId: row.id, maxActions: recipe.maxActions, primaryCriterion: recipe.primaryCriterion })
    tasks.push({ id: row.id, familyId: row.familyId, split: row.split,
      root: { use: catalog[0].id, params: { caseId: row.id, instruction: row.instruction, maxActions: recipe.maxActions, resources: canonical(packet.publicInput.resources), goals: canonical(packet.publicInput.goals),
        actionContract: canonical(packet.publicInput.actionContract), limits: canonical(packet.publicInput.limits) } },
      input: copy(packet.publicInput), expected: null, resource: packet,
      factors: { resources: row.resources.length, goals: row.goals.length, 'visible-resources': row.resources.filter(resource => resource.visible).length, 'writable-resources': row.resources.filter(resource => resource.writable).length } })
    cases.push({ id: row.id, packetSha256: packet.sha256, referencePlan: copy(packet.referencePlan), controls: generatedControls(packet) })
  }
  const contract = { format: 'research-experiment-template', version: EXPERIMENT_TEMPLATE_VERSION, kind: recipe.kind, recipeSha256,
    generatedSha256: await sha256(canonical({ catalog, tasks })), primaryCriterion: recipe.primaryCriterion, cases, limits: limitsFor(recipe), generatedEvidenceBudget: generatedBudget,
    capabilities: { domain: 'generic', interaction: 'single-plan', resources: 'fresh owned synthetic resource Map per attempt after durable response collection',
      operations: ['set', 'delete'], adapters: ['replay', 'http'], attemptsPerTrial: 1, toolsExposedDuringCollection: 0,
      measurement: 'Independent observation after every action; task success, net/ever collateral effects and peak collateral count remain distinct.',
      scope: 'No arbitrary code, filesystem/service effects, interactive agent tools, persistent/shared resource state or provider authentication is inferred.' },
    qualification: { required: true, mechanism: 'source-bound-resource-conformance', sourceFiles: ['templates.mjs', 'resource-effects.mjs'],
      reference: 'Generated from exact case goals and resource fixtures; caller-authored expected answers cannot replace it.',
      controls: 'Generated case controls record applicability; a control plan is not an execution or successful qualification receipt.',
      status: 'required-before-collection', limitation: 'Qualification does not authorize counted collection, authenticate an investigator or certify an unidentified external paper.' } }
  return { catalog, tasks, contract }
}

export async function compileExperimentTemplate(spec) {
  if (spec?.experimentTemplate === undefined) return null
  const projectedEvidence = validateExperimentTemplate(spec), generated = await materializeExperimentTemplate(spec.experimentTemplate)
  invariant(canonical(spec.catalog) === canonical(generated.catalog), 'The resource catalog differs from its template recipe. Regenerate the experiment from its fields before freezing.')
  invariant(canonical(spec.tasks) === canonical(generated.tasks), 'The resource tasks, public inputs, private packets or expected criteria differ from their template recipe. Regenerate before freezing.')
  return { ...generated.contract, limits: { ...generated.contract.limits, maxQualificationReceipts: projectedEvidence.maxQualificationReceipts }, projectedEvidence }
}

export function templateProjectFiles(project) {
  if (!project.experimentTemplate && !project.spec?.experimentTemplate) return {}
  const contract = project.experimentTemplate
  invariant(contract?.format === 'research-experiment-template' && contract.version === 1 && contract.kind === 'resource-action-plan', 'The resource template needs its compiled contract before export.')
  const file = value => canonical(value) + '\n'
  const files = { 'templates/recipe.json': file(project.spec.experimentTemplate), 'templates/contract.json': file(contract) }
  for (const row of contract.cases) {
    const task = project.tasks.find(task => task.id === row.id)
    invariant(task?.resource?.sha256 === row.packetSha256 && canonical(task.resource.referencePlan) === canonical(row.referencePlan), 'A generated resource artifact has a different task packet binding.')
    files['templates/cases/' + row.id + '/packet.json'] = file(task.resource)
    files['templates/cases/' + row.id + '/public-input.json'] = file(task.input)
    files['templates/cases/' + row.id + '/reference-plan.json'] = file(row.referencePlan)
    files['templates/cases/' + row.id + '/controls.json'] = file(row.controls)
  }
  return files
}
