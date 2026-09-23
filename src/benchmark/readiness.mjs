// Static, portable experiment admission. This does not execute an oracle,
// authenticate a host/provider, or replace the runner's fresh proof ledger.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { extractSource, sourceFailureClassification } from './extraction.mjs'
import { modernSchema, SUPPORTED_SCHEMA_VERSIONS } from './study-schema.mjs'
import { benchmarkForDomain, environmentKeysFor, gradingKind, isRegisteredDomain } from './registry.mjs'

// A domain some benchmark registered, that ToolsEnabled does not itself ship.
function thirdPartyDomain(domain) {
  return isRegisteredDomain(domain) && benchmarkForDomain(domain)?.firstParty !== true
}

// A grading contract this study's own benchmark declared. Without this, a third
// party could declare a contract, freeze with it and then be refused at the run
// gate -- the page would offer a control the core would not honour.
function ownDeclaredContract(domain, grading) {
  const contract = gradingKind(grading)
  return Boolean(contract?.benchmarkId) && contract.benchmarkId === benchmarkForDomain(domain)?.id
}
import { extractionPolicyFor } from './registry.mjs'
import { decodeInformationResponse } from './information.mjs'

export const READINESS_VERSION = 1
const HASH = /^[a-f0-9]{64}$/
const own = (value, key) => object(value) && Object.hasOwn(value, key)
const text = value => typeof value === 'string' && !!value.trim()
const fields = (value, allowed, label) => invariant(object(value) && Object.keys(value).every(key => allowed.includes(key)), label + ' contains unsupported fields.')
const scope = 'Static operation eligibility only. Fresh required qualification, remaining budgets, durable evidence and existing personal/native/release gates are separate. No authenticated execution or scientific correctness is inferred.'
const builtin = ['exact', 'json', 'judge-audit', 'resource-action-plan']
// Match workflowFor's condition assignment without importing the execution
// implementation into this pure portable admission descriptor.
const selectedWorkflow = (spec, condition) => condition.workflowId ? spec.workflowPlan?.workflows.find(workflow => workflow.id === condition.workflowId) : null
const requestedContext = (spec, condition) => {
  const workflow = selectedWorkflow(spec, condition)
  return { conditionId: condition.id, workflowId: workflow?.id || null,
    contextConstruction: workflow ? 'frozen-workflow-projection' : condition.collection?.contextConstruction ?? null,
    sessionIsolation: workflow ? 'fresh-call-requested' : condition.collection?.sessionIsolation ?? null }
}

export function validateExecutionPlan(spec) {
  invariant(object(spec), 'Readiness needs a study specification.')
  if (spec.schemaVersion === 1) {
    invariant(!Object.hasOwn(spec, 'executionPlan'), 'A legacy schema-1 study cannot carry a new execution plan; explicitly create a schema-2 study.')
    return null
  }
  invariant(modernSchema(spec), 'Readiness supports study schemas 1, 2 and 3.')
  const plan = spec.executionPlan
  fields(plan, ['version', 'purpose', 'design'], 'Execution plan')
  invariant(plan.version === 1 && ['experiment', 'recorded-diagnostic', 'apparatus-development'].includes(plan.purpose), 'Choose a version 1 experiment, recorded-diagnostic or apparatus-development execution purpose.')
  if (plan.purpose === 'experiment' || plan.design !== undefined) {
    const design = plan.design
    fields(design, ['schedule', 'replicates', 'primaryOutcome', 'dependence'], 'Experiment design')
    invariant(design.schedule === 'crossed-task-condition', 'Supported experiments cross every frozen task and condition.')
    invariant(design.replicates === 'repeated-measurements', 'Replicates are repeated measurements, not independently sampled tasks.')
    invariant(design.primaryOutcome === 'binary-pass', 'This experiment contract supports the binary pass endpoint only.')
    invariant(['descriptive-only', 'family-clusters'].includes(design.dependence), 'Choose descriptive-only analysis or explicit family-clusters dependence.')
  }
  return plan
}

function populationFor(project, add) {
  const { spec } = project, tasks = project.tasks, selection = spec.analysisPlan?.primaryPopulation
  const empty = { selection: null, label: 'Primary population undeclared', taskIds: [], ledger: tasks.map(task => ({ taskId: task.id, split: task.split, included: false, reason: 'primary-population-undeclared' })) }
  if (selection === undefined) { add('primary-population-required', 'analysisPlan.primaryPopulation', 'Select an explicit primary population before collecting an experiment.'); return empty }
  let includes, label, reason
  if (spec.auditPlan) {
    if (selection !== 'reference-eligible') { add('audit-population-required', 'analysisPlan.primaryPopulation', 'Judge audits require the exact reference-eligible population.'); return empty }
    includes = task => task.audit?.referenceVerdict != null; label = 'Reference-eligible audit cases'; reason = 'unresolved-reference'
  } else if (selection === 'all') { includes = () => true; label = 'All frozen tasks' }
  else if (object(selection) && Object.keys(selection).every(key => ['kind', 'split'].includes(key)) && selection.kind === 'split' && ['development', 'held-out'].includes(selection.split)) {
    includes = task => task.split === selection.split; label = selection.split === 'held-out' ? 'Held-out tasks' : 'Development tasks'; reason = 'outside-selected-split'
  } else if (object(selection) && Object.keys(selection).every(key => ['kind', 'taskIds'].includes(key)) && selection.kind === 'task-set'
    && Array.isArray(selection.taskIds) && selection.taskIds.length && new Set(selection.taskIds).size === selection.taskIds.length
    && selection.taskIds.every(id => tasks.some(task => task.id === id))) {
    const selected = new Set(selection.taskIds); includes = task => selected.has(task.id); label = 'Explicit frozen task set'; reason = 'outside-explicit-task-set'
  } else { add('primary-population-unsupported', 'analysisPlan.primaryPopulation', 'Select all tasks, a frozen split, an explicit task set, or the applicable audit population.'); return empty }
  const ledger = tasks.map(task => { const included = includes(task); return { taskId: task.id, split: task.split, included, reason: included ? null : reason } })
  const result = { selection, label, taskIds: ledger.filter(row => row.included).map(row => row.taskId), ledger }
  if (!result.taskIds.length) add('primary-population-empty', 'analysisPlan.primaryPopulation', 'The primary population has no eligible frozen tasks.')
  if (project.primaryPopulation && canonical(project.primaryPopulation) !== canonical(result)) add('primary-population-drift', 'primaryPopulation', 'The compiled primary roster differs from the declared population.')
  return result
}

function compositionCoverage(project, add) {
  const packet = project.requirements, selected = packet?.selectedInput
  if (!selected || selected.policy !== 'require-composition') add('composition-policy-required', 'requirementPlan.selectedInput.policy', 'Require complete selected-input composition qualification before collecting semantic answers.')
  const actual = []
  for (const task of project.tasks) {
    const variants = task.information ? task.interpretations : [task]
    if (!Array.isArray(variants) || !variants.length) { add('composition-coverage-missing', 'tasks.' + task.id, 'Every task and admissible reading needs compiled composition coverage.'); continue }
    for (const variant of variants) {
      const nodes = variant.compiled?.composition?.nodes
      if (!Array.isArray(nodes) || !nodes.length) { add('composition-coverage-missing', 'tasks.' + task.id, 'Every semantic task needs a nonempty compiled composition.'); continue }
      for (const node of nodes) actual.push({ taskId: task.id, readingId: variant === task ? null : variant.id, requirementId: node.path + '#' + node.bundle.id })
    }
  }
  const key = row => canonical([row.taskId, row.readingId || null, row.requirementId || row.requirement?.requirementId])
  const targets = packet?.targets || [], covered = new Set(targets.map(key)), missing = actual.filter(row => !covered.has(key(row)))
  if (missing.length || !actual.length || selected?.compositionOccurrences !== actual.length || selected?.unregistered?.length !== 0
    || targets.length !== actual.length || covered.size !== targets.length)
    add('composition-coverage-incomplete', 'requirementPlan.targets', 'Register every selected task/reading composition occurrence exactly once; no missing or extra coverage can authorize collection.')
  if (targets.some(target => !target.selectedInput || !target.activation?.length || !target.probes?.length || !target.selectedInput.wrongReadings?.length
    || target.selectedInput.wrongReadings.some(wrong => wrong.constructionError || !wrong.task)))
    add('qualification-controls-incomplete', 'requirementPlan.targets', 'Every occurrence needs activation, hand-checked probes and distinguishable wrong readings for its selected input.')
  return { occurrences: actual.length, registered: targets.length, missing }
}

function collectorContracts(project, add) {
  const { spec } = project
  if (spec.workflowPlan && !project.workflows) add('workflow-contract-required', 'workflowPlan', 'Compile the frozen workflow before admitting its collection path.')
  for (const workflow of spec.workflowPlan?.workflows || []) if (workflow.budgets?.maxToolCalls !== 0 || workflow.stages?.some(stage => stage.allowedTools?.length))
    add('opaque-tools-unsupported', 'workflowPlan.workflows.' + workflow.id, 'The admitted answer profiles support explicit prompt workflows without opaque external tools.')
  for (const condition of spec.conditions) {
    const path = 'conditions.' + condition.id, adapter = condition.adapter
    if (!['replay', 'http'].includes(adapter?.kind)) add('collector-unsupported', path + '.adapter.kind', 'This experiment profile supports recorded replay or the bounded public HTTPS request; command/module collectors need a registered execution contract.')
    if (condition.collection?.tools?.length) add('opaque-tools-unsupported', path + '.collection.tools', 'This profile does not independently enforce or observe opaque external tools.')
    if (adapter?.kind === 'replay') continue
    const collection = condition.collection
    if (!object(collection) || collection.comparisonUnit !== 'model' || !Array.isArray(collection.tools) || collection.tools.length
      || !text(collection.contextConstruction) || !text(collection.sessionIsolation)
      || !object(collection.instructions) || !['system', 'developer'].every(key => own(collection.instructions, key) && (collection.instructions[key] === null || typeof collection.instructions[key] === 'string')))
      add('collection-controls-required', path + '.collection', 'Declare model comparison, exact instructions, no tools and the public/fresh-request collection boundary.')
    // A declared restriction nothing can observe is a claim, not a control. Without a mapping
    // for the adapter-reported tool count, no attempt can ever agree or disagree with this
    // declaration, so the study and its report can only repeat the claim back.
    const usageMapping = { ...spec.observationPlan?.mapping?.usage, ...spec.observationPlan?.overrides?.[condition.id]?.mapping?.usage }
    if (Array.isArray(collection?.tools) && !collection.tools.length && !usageMapping.toolCalls)
      add('tool-policy-unobservable', path + '.collection.tools', 'This condition declares no tools, but nothing maps the adapter-reported tool count, so no attempt can check the declaration against what the adapter did. Map usage.toolCalls in the observation plan.')
    if (modernSchema(spec) && spec.executionPlan.purpose === 'experiment' && adapter?.kind === 'http') {
      const workflow = selectedWorkflow(spec, condition)
      const context = workflow ? 'frozen-workflow-projection' : 'frozen-public-request', isolation = workflow ? 'fresh-call-requested' : 'fresh-request'
      if (collection?.contextConstruction !== context || collection?.sessionIsolation !== isolation)
        add('requested-context-unsupported', path + '.collection', 'This condition requires contextConstruction=' + context + ' and sessionIsolation=' + isolation + '. These values describe the sent request; provider adherence and hidden history remain unobserved.')
    }
    const plan = spec.observationPlan, override = plan?.overrides?.[condition.id] || {}, identity = override.identity || plan?.identity, completion = override.completion || plan?.completion
    const identityMapping = { ...plan?.mapping?.identity, ...override.mapping?.identity }, completionMapping = { ...plan?.mapping?.completion, ...override.mapping?.completion }
    if (identity?.policy !== 'require-match' || !['provider', 'id'].every(field => identity.fields?.includes(field) && text(condition.model?.[field]) && Array.isArray(identityMapping[field]) && identityMapping[field].length))
      add('reported-identity-required', 'observationPlan', 'External experiment collection requires matching reported provider and model id; this is not provider authentication.')
    if (completion?.policy !== 'require-complete' || !Array.isArray(completionMapping.status) || !completionMapping.status.length) add('reported-completion-required', 'observationPlan', 'External experiment collection requires complete reported generation before admitting an outcome.')
  }
  // WHICH ENVIRONMENT KEYS EXIST IS A REGISTRATION, NOT A LIST HERE. This was a
  // literal allowlist with a vertical's own key inside it ('leanImage'), and it
  // is a BLOCKER, not a branch: assertCollectionAdmission turns it into a hard
  // refusal, so a third-party benchmark whose grading contract needs any frozen
  // configuration of its own could freeze a study and then never run it. The
  // core's keys come from CORE_ENVIRONMENT_KEYS; a benchmark's come from
  // whoever registered it.
  if (spec.environment && Object.keys(spec.environment).some(key => !environmentKeysFor(spec).includes(key)))
    add('execution-environment-unsupported', 'environment', 'Shared, persistent or custom execution environments need a registered capability contract.')
}

function descriptor(project) {
  const { spec } = project, plan = validateExecutionPlan(spec), blockers = [], scientificBlockers = []
  invariant(Array.isArray(project.tasks) && Array.isArray(project.schedule) && Array.isArray(spec.conditions), 'Readiness needs compiled tasks, schedule and conditions.')
  const add = (code, path, message) => { if (!blockers.some(row => row.code === code && row.path === path)) blockers.push({ code, path, message }) }
  const scientific = (code, path, message) => { if (!scientificBlockers.some(row => row.code === code && row.path === path)) scientificBlockers.push({ code, path, message }) }
  const purpose = plan?.purpose || 'legacy', grading = spec.protocol?.grading?.kind, requiredProofs = []
  const proof = (kind, proofScope) => { if (!requiredProofs.some(row => row.kind === kind)) requiredProofs.push({ kind, scope: proofScope }) }
  let profile = { id: 'recorded-answer-diagnostic', version: 1, scope: 'Consistency of saved answers with their frozen grading rule; no qualified oracle or new provider measurement is inferred.' }, coverage = null
  if (grading === 'resource-action-plan') {
    profile = { id: 'resource-action-plan', version: 1, scope: 'One returned action plan executed and independently observed in a fresh owned synthetic resource map; no filesystem, service, interactive agent or provider authentication claim.' }
    proof('source-bound-resource-conformance', 'Fresh fixed and exact selected-case controls, independently verified against the generated resource contract.')
    if (project.experimentTemplate?.kind !== 'resource-action-plan' || project.tasks.some(task => !task.resource || task.expected !== null)) add('resource-contract-required', 'experimentTemplate', 'Resource grading requires the complete generated recipe, private packet and observer contract.')
  } else if (grading === 'lean-python') {
    profile = { id: 'lean-native-unadmitted', version: 1, scope: 'Candidate code needs native source/image/data/observer/control admission; semantic answer qualification is insufficient.' }
    scientific('native-admission-unavailable', 'protocol.grading.kind', 'Native candidate collection remains blocked until its source, image, data, observer and control admission mechanism is implemented and the original gates are satisfied.')
    // A recorded response is routed exactly as gradeLean routes a live answer. A structured
    // JSON value where a program is graded -- the JSON starter's trace canary kept after
    // switching to lean-python -- can only record no-program, while every earlier gate
    // passed; refuse it before an engine run is paid for. Tagged clarification/refusal
    // envelopes are designed non-answers, and null or string responses still receive the
    // grader's own visible no-program classification, which negative controls rely on.
    for (const condition of spec.conditions) {
      const responses = condition.adapter?.kind === 'replay' ? condition.adapter.responses : null
      if (!object(responses)) continue
      for (const task of project.tasks) {
        if (!Object.hasOwn(responses, task.id)) continue
        let answer = responses[task.id]
        if (task.information) {
          const decoded = decodeInformationResponse(task, answer)
          if (decoded.behavior !== 'answer') continue
          answer = decoded.answer
        }
        if (answer === null || typeof answer !== 'object') continue
        // Which bytes count as the program is the study's declared extraction
        // policy, not a Python rule the core happens to know.
        const policy = extractionPolicyFor(spec)
        try { extractSource(answer, policy) } catch (error) {
          add('replay-response-not-a-program', 'conditions.' + condition.id + '.adapter.responses.' + task.id,
            `The recorded response for task "${task.id}" in condition "${condition.id}" is a JSON value, not a program (${error.message}), so every trial would record ${sourceFailureClassification(error)}. Record one ${policy.label} program, or grade this study as JSON.`)
        }
      }
    }
  } else if (grading === 'judge-audit') {
    profile = { id: 'reference-audit', version: 1, scope: 'Judge agreement with the exact frozen reference criterion and its eligible cases; not universal correctness or a new native source execution.' }
    if (!project.audit || !HASH.test(project.audit.sha256 || '') || project.audit.manifest?.referenceSha256 !== spec.auditPlan?.reference?.sha256
      || project.tasks.some(task => task.audit?.referenceSha256 !== spec.auditPlan?.reference?.sha256)) add('audit-reference-required', 'auditPlan', 'Bind every audit case and the compiled audit manifest to the verified exact reference bundle.')
  } else if (spec.domain === 'lean-bench' && grading === 'json') {
    profile = { id: 'lean-semantic-answer', version: 1, scope: 'Requires independent JavaScript/Python interpretation of semantic or operational JSON answers; no native execution of candidate code is inferred.' }
  } else if (spec.domain === 'generic' && ['exact', 'json'].includes(grading)) {
    profile = { id: 'generic-interpreted-answer', version: 1, scope: 'Requires selected answers checked by distinct pinned interpreter modules and registered controls. Agreement does not prove scientific independence or arbitrary program effects.' }
  } else if (thirdPartyDomain(spec.domain) && (['exact', 'json'].includes(grading) || ownDeclaredContract(spec.domain, grading))) {
    // A benchmark ToolsEnabled did not write. It MAY RUN -- refusing would make
    // the registration seam pointless, and running someone else's benchmark is
    // the point of it. What it does not get is ToolsEnabled's scientific
    // admission: that claim is about apparatus ToolsEnabled has qualified, and
    // granting it automatically to anyone who registers a domain would make it
    // worth nothing. The distinction lives in the profile, which travels in the
    // readiness contract and is printed in the exported report.
    profile = { id: 'third-party-declared-endpoint', version: 1,
      scope: 'A benchmark registered by a third party, graded by its own declared endpoint and extraction policy. ToolsEnabled runs the study and records exactly what was returned and how it was graded. It does not qualify the grader, the answer key or the interpreter, and no ToolsEnabled scientific-validity admission is claimed for these results.' }
    proof('third-party-declared-apparatus', 'The registering benchmark qualifies its own grader, answer key and interpreter. ToolsEnabled records the run, not its validity.')
  } else scientific('scientific-endpoint-unsupported', 'protocol.grading', 'Register a supported generated or independently interpreted binary endpoint; an arbitrary custom grader cannot establish its own scientific validity.')

  if (modernSchema(spec)) {
    const inventory = project.runtimeFiles, sources = spec.runtimeSources
    if (!Array.isArray(inventory) || !inventory.length || inventory.some(file => !text(file)) || new Set(inventory).size !== inventory.length
      || !object(sources) || canonical([...inventory].sort()) !== canonical(Object.keys(sources).sort()) || Object.values(sources).some(digest => !HASH.test(digest)))
      add('complete-runtime-pins-required', 'runtimeSources', 'Bind every file in the authoritative compiled runtime inventory exactly once; missing, extra or invalid source pins cannot authorize execution.')
  }
  if (purpose === 'apparatus-development') {
    if (spec.analysisPlan?.cohort !== 'qualification') add('development-cohort-required', 'analysisPlan.cohort', 'Apparatus development remains in the qualification cohort; changing cohort cannot upgrade its evidence.')
    const protocol = spec.protocol, limits = { maxAttemptsPerTrial: 10, maxTotalAttempts: 100000, timeoutMs: 3600000, maxDurationMs: 86400000 }
    if (Object.entries(limits).some(([key, maximum]) => !Number.isSafeInteger(protocol[key]) || protocol[key] < 1 || protocol[key] > maximum))
      add('development-budgets-required', 'protocol', 'Apparatus development requires the existing finite positive attempt, total-attempt, attempt-time and study-time budgets.')
  }
  if (project.requirements?.selectedInput && project.requirements.selectedInput.policy !== 'report') proof('selected-input-qualification', 'Fresh paired qualification of exact selected inputs and their declared requirement controls.')
  const population = populationFor(project, scientific)
  {
    if (!plan?.design) scientific('experiment-design-required', 'executionPlan.design', 'Experimental admission requires the explicit supported schedule, outcome and dependence design.')
    if (builtin.includes(grading) && Object.keys(spec.protocol.grading).some(key => key !== 'kind')) scientific('grading-configuration-unsupported', 'protocol.grading', 'The admitted binary grader has no additional authored metric or execution options.')
    if (!object(spec.analysisPlan) || spec.analysisPlan.primaryDenominator !== 'scheduled') scientific('scheduled-denominator-required', 'analysisPlan.primaryDenominator', 'The binary primary endpoint includes all scheduled trials in the declared population.')
    const uncertainty = spec.analysisPlan?.uncertainty
    if (plan?.design?.dependence === 'descriptive-only' && (uncertainty !== null || spec.analysisPlan?.multiplicity !== 'none-descriptive'))
      scientific('descriptive-analysis-required', 'analysisPlan.uncertainty', 'Descriptive-only designs use no uncertainty interval or inferential multiplicity adjustment.')
    if (plan?.design?.dependence === 'family-clusters') {
      if (uncertainty?.kind !== 'family-bootstrap') scientific('family-bootstrap-required', 'analysisPlan.uncertainty', 'Family-clusters designs require the supported family bootstrap.')
      const primary = project.tasks.filter(task => population.taskIds.includes(task.id)), families = new Set(primary.map(task => task.familyId))
      if (primary.some(task => !text(task.familyId)) || families.size < 2) scientific('family-units-required', 'tasks.familyId', 'Family uncertainty requires explicit family units and at least two primary-population families; replicates are not independent task samples.')
    }
    const expected = new Set(project.tasks.flatMap(task => spec.conditions.flatMap(condition => Array.from({ length: spec.protocol.replicates }, (_, index) => canonical([task.id, condition.id, index + 1])))))
    const actual = project.schedule.map(row => canonical([row.taskId, row.conditionId, row.replicate]))
    if (actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some(row => !expected.has(row))) scientific('crossed-schedule-required', 'schedule', 'The schedule must contain every frozen task/condition/replicate combination exactly once.')
    if (['generic-interpreted-answer', 'lean-semantic-answer'].includes(profile.id)) {
      coverage = compositionCoverage(project, scientific)
      if (purpose === 'experiment') proof('selected-input-qualification', 'Fresh paired independent qualification of every selected task/reading composition occurrence, activation rule and wrong-reading control.')
      if (profile.id === 'generic-interpreted-answer') {
        const modules = project.requirements?.interpreters, reference = modules?.reference, independent = modules?.independent
        if (!reference || !independent || !HASH.test(reference.sha256 || '') || !HASH.test(independent.sha256 || '') || reference.file === independent.file || reference.sha256 === independent.sha256
          || ![reference, independent].every(binding => spec.inputs?.some(input => input.path === binding.file && input.sha256 === binding.sha256))
          || reference.file !== spec.requirementPlan?.interpreters?.reference || independent.file !== spec.requirementPlan?.interpreters?.independent)
          scientific('independent-oracle-required', 'requirementPlan.interpreters', 'Register distinct source-pinned reference and independent interpreter modules; an authored answer key or passed grader result is insufficient.')
      }
    }
    collectorContracts(project, scientific)
  }
  let referenceAncestry = null
  if (spec.auditPlan) {
    const reference = spec.auditPlan.reference, source = reference?.project
    referenceAncestry = { referenceSha256: reference?.sha256 || null, sourceProjectSha256: source?.sha256 || null,
      sourceSchemaVersion: source?.spec?.schemaVersion || null, sourcePurpose: source?.spec?.schemaVersion === 1 ? 'legacy-unclassified' : source?.spec?.executionPlan?.purpose || 'unavailable',
      sourceReadinessSha256: source?.readiness?.sha256 || null,
      scope: 'Reference ancestry retains its original evidence purpose. Development computations, recorded diagnostics and legacy artifacts are not upgraded into scientific source execution by an audit.' }
    if (!source || !SUPPORTED_SCHEMA_VERSIONS.includes(source.spec?.schemaVersion) || !HASH.test(source.sha256 || '')) scientific('audit-source-scope-required', 'auditPlan.reference', 'Retain the exact source project and its original purpose when deriving audit reference eligibility.')
  }
  return { purpose, profile, design: plan?.design || null, population, coverage, referenceAncestry, endpoint: { kind: 'binary-pass', grading: spec.protocol.grading }, requiredProofs,
    capabilities: { collectors: ['replay', 'http'], interaction: spec.workflowPlan ? 'explicit-sequential-prompt-workflow-without-tools' : 'one-public-request',
      state: grading === 'resource-action-plan' ? 'fresh-owned-synthetic-resource-map' : 'no-candidate-resource-execution',
      tools: [], identity: 'adapter-reported-agreement-only', transportHost: 'trusted-embedding-no-authored-capability-flags',
      requestedContext: { scope: 'Sent-request context only: the ordinary request contains the frozen public prompt and input; a selected workflow sends only its declared task visibility and ancestor output projections. Fresh-session values request no implicit history. Provider adherence, hidden history and actual session isolation remain unobserved.',
        conditions: spec.conditions.filter(condition => condition.adapter?.kind === 'http').map(condition => requestedContext(spec, condition)) },
      conditionOrigins: spec.conditions.map(condition => ({ conditionId: condition.id, origin: condition.adapter?.kind === 'replay' ? 'recorded-response' : 'external-collection' })) },
    limits: { maxAttemptsPerTrial: spec.protocol.maxAttemptsPerTrial, maxTotalAttempts: spec.protocol.maxTotalAttempts, timeoutMs: spec.protocol.timeoutMs, maxDurationMs: spec.protocol.maxDurationMs,
      preparation: project.experimentTemplate?.limits || (requiredProofs.some(row => row.kind === 'selected-input-qualification') ? { maxPreparations: spec.protocol.maxTotalAttempts + 1, settlementMs: 5000, proofBytes: 4194304, journalBytes: 16777216, eventEvidenceBytes: 33554432 } : null) },
    blockers: purpose === 'experiment' ? [...blockers, ...scientificBlockers] : blockers, scientificBlockers,
    scope: purpose === 'apparatus-development' ? 'Apparatus development computations only; no scientific inference or experimental admission. ' + scope : scope }
}

export async function deriveReadinessContract(project) {
  if (!validateExecutionPlan(project.spec)) return null
  const body = descriptor(project)
  const bindings = Object.fromEntries(await Promise.all(Object.entries({ specification: project.spec, tasks: project.tasks, schedule: project.schedule,
    population: body.population, runtimeFiles: project.runtimeFiles || [], runtimeSources: project.spec.runtimeSources || {}, inputs: project.spec.inputs || [], endpoint: body.endpoint,
    requirements: project.requirements || null, experimentTemplate: project.experimentTemplate || null, audit: project.audit || null, workflows: project.workflows || null })
    .map(async ([key, value]) => [key + 'Sha256', await sha256(canonical(value))])))
  const contract = { format: 'research-experiment-readiness', version: READINESS_VERSION, ...body, bindings }
  return { ...contract, sha256: await sha256(canonical(contract)) }
}

export function readinessProjectFiles(project) {
  if (project.spec.schemaVersion === 1) { invariant(!project.readiness, 'A legacy project cannot carry a generated readiness claim.'); return {} }
  invariant(project.readiness?.format === 'research-experiment-readiness' && project.readiness.version === READINESS_VERSION, 'Generate the schema-2 readiness contract before exporting.')
  return { 'readiness/contract.json': canonical(project.readiness) + '\n', 'readiness/population.json': canonical(project.readiness.population) + '\n' }
}

export function evaluateReadiness(project, options = {}) {
  fields(options, ['operation'], 'Readiness evaluation options')
  const operation = options.operation || 'collect'
  invariant(['collect', 'diagnostic-replay', 'apparatus-development'].includes(operation), 'Choose collect, diagnostic-replay or apparatus-development readiness evaluation.')
  const derived = descriptor(project), blockers = [...derived.blockers]
  const add = (code, path, message) => { if (!blockers.some(row => row.code === code && row.path === path)) blockers.push({ code, path, message }) }
  if (modernSchema(project.spec)) {
    const contract = project.readiness, { format, version, bindings, sha256: digest, ...retained } = contract || {}
    if (format !== 'research-experiment-readiness' || version !== READINESS_VERSION || !HASH.test(digest || '') || !object(bindings)
      || Object.values(bindings).some(value => !HASH.test(value)) || canonical(retained) !== canonical(derived))
      add('readiness-contract-missing-or-changed', 'readiness', 'Regenerate and verify the complete frozen readiness contract before execution.')
  } else if (project.readiness) add('legacy-readiness-claim', 'readiness', 'Legacy evidence cannot be relabeled with a new readiness claim.')
  if (operation === 'collect') {
    for (const row of derived.scientificBlockers) add(row.code, row.path, row.message)
    if (derived.purpose !== 'experiment') add('experiment-purpose-required', 'executionPlan.purpose', 'New experimental collection requires an explicit schema-2 experiment; cohort and legacy proofs cannot bypass this boundary.')
  } else if (operation === 'apparatus-development') {
    if (!modernSchema(project.spec) || derived.purpose !== 'apparatus-development') add('development-purpose-required', 'executionPlan.purpose', 'Apparatus development requires an explicit schema-2-or-later development purpose; legacy artifacts and experimental studies cannot silently switch operations.')
  } else {
    if (!['legacy', 'recorded-diagnostic'].includes(derived.purpose)) add('diagnostic-purpose-required', 'executionPlan.purpose', 'Diagnostic replay requires a legacy project or an explicit recorded-diagnostic purpose.')
    if (!builtin.includes(project.spec.protocol.grading.kind)) add('diagnostic-grader-unsupported', 'protocol.grading.kind', 'Recorded diagnostics use only the owned exact/json/judge/resource graders; native or custom execution is unsupported.')
    if (!project.spec.conditions.length || project.spec.conditions.some(condition => condition.adapter?.kind !== 'replay')) add('recorded-responses-required', 'conditions', 'Recorded diagnostics cannot invoke external, command or module collectors.')
  }
  return { operation, purpose: derived.purpose, profile: derived.profile, eligible: blockers.length === 0, blockers, requiredProofs: derived.requiredProofs, scope: derived.scope }
}

export function assertCollectionAdmission(project, options = {}) {
  fields(options, ['operation', 'canonicalReplay'], 'Collection admission options')
  const result = evaluateReadiness(project, { operation: options.operation || 'collect' })
  if (result.operation === 'diagnostic-replay' && options.canonicalReplay !== true) result.blockers.push({ code: 'canonical-replay-required', path: 'adapter',
    message: 'Recorded diagnostics require the actual owned replay transport and owned grader; a caller override cannot masquerade as replay.' })
  result.eligible = result.blockers.length === 0
  invariant(result.eligible, result.blockers.map(row => row.code + ': ' + row.message).join(' '))
  return result
}
