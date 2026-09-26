// A frozen, sequential prompt graph. Trading Strategy/Template recursion is
// compiled separately; this module only controls collection calls.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { observeResponse } from './observations.mjs'

const ID = /^[a-z][a-z0-9_-]{0,63}$/
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const bytes = value => new TextEncoder().encode(canonical(value)).length
const keys = (value, allowed, label) => invariant(object(value) && Object.keys(value).every(key => allowed.includes(key)), `${label}: unknown field or invalid object.`)
const path = value => Array.isArray(value) && value.length <= 16 && value.every(key => typeof key === 'string' && key.length <= 256 || integer(key, 0, 1000000))
function at(value, location) {
  for (const key of location) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false }
    value = value[key]
  }
  return { found: true, value }
}
const targets = stage => [...stage.next.branches.map(branch => branch.to), stage.next.otherwise].filter(target => target !== null)
export function workflowFor(spec, condition) {
  return condition.workflowId ? spec.workflowPlan?.workflows.find(workflow => workflow.id === condition.workflowId) : null
}
export function workflowDraft(spec) {
  return { plan: { version: 1, workflows: [{ id: 'prompt-flow', purpose: 'orchestration', rationale: 'One explicit prompt stage. Replace this draft with the intended treatment or orchestration protocol.',
    entry: 'answer', failurePolicy: 'halt-study', budgets: { maxCalls: 1, maxRequestBytes: 1048576, maxResponseBytes: 1048576, maxToolCalls: 0, maxOutputTokens: null },
    stages: [{ id: 'answer', instructions: { system: null, developer: null, user: 'Complete the frozen task.' }, includeTaskPrompt: true, includeTaskInput: true,
      parents: [], allowedTools: [], timeoutMs: Math.min(60000, spec.protocol.timeoutMs), next: { branches: [], otherwise: null }, resultPath: [] }] }] },
    assignments: Object.fromEntries(spec.conditions.map(condition => [condition.id, 'prompt-flow'])) }
}
export function applyWorkflowDraft(spec, draft) {
  keys(draft, ['plan', 'assignments'], 'Workflow draft')
  invariant(object(draft.assignments) && Object.keys(draft.assignments).length === spec.conditions.length && spec.conditions.every(condition => Object.hasOwn(draft.assignments, condition.id)), 'Assign each current condition a workflow identifier or explicit null.')
  const next = structuredClone(spec)
  if (draft.plan === null) delete next.workflowPlan; else next.workflowPlan = draft.plan
  for (const condition of next.conditions) {
    const id = draft.assignments[condition.id]
    if (id === null) delete condition.workflowId; else { invariant(ID.test(id), 'A workflow assignment needs a lowercase identifier or null.'); condition.workflowId = id }
  }
  validateWorkflowPlan(next)
  return next
}

export function validateWorkflowPlan(spec) {
  const plan = spec.workflowPlan
  if (plan === undefined) { invariant(spec.conditions.every(condition => condition.workflowId === undefined), 'A condition workflow needs a frozen workflow plan.'); return }
  keys(plan, ['version', 'workflows'], 'Workflow plan')
  invariant(plan.version === 1 && Array.isArray(plan.workflows) && plan.workflows.length > 0 && plan.workflows.length <= 32, 'Declare 1–32 version 1 workflows.')
  invariant(spec.observationPlan, 'Prompt workflows require a frozen accounting plan for every collection call.')
  const ids = new Set()
  for (const workflow of plan.workflows) {
    keys(workflow, ['id', 'purpose', 'rationale', 'entry', 'failurePolicy', 'budgets', 'stages'], 'Workflow')
    invariant(ID.test(workflow.id) && !ids.has(workflow.id), 'Workflows need distinct lowercase identifiers.'); ids.add(workflow.id)
    invariant(['treatment', 'orchestration'].includes(workflow.purpose) && typeof workflow.rationale === 'string' && workflow.rationale.trim(), 'Declare whether the workflow is a treatment or orchestration, with its rationale.')
    invariant(workflow.failurePolicy === 'halt-study', 'Version 1 workflows halt on any stage failure or interruption; partial workflows cannot be redrawn.')
    const budget = workflow.budgets
    keys(budget, ['maxCalls', 'maxRequestBytes', 'maxResponseBytes', 'maxToolCalls', 'maxOutputTokens'], 'Workflow budget')
    invariant(integer(budget.maxCalls, 1, 32) && integer(budget.maxRequestBytes, 1, 8 * 1024 * 1024) && integer(budget.maxResponseBytes, 1, 8 * 1024 * 1024) && integer(budget.maxToolCalls, 0, 1024), 'Declare bounded workflow calls, request bytes per call, total retained response bytes and reported tool calls.')
    invariant(budget.maxOutputTokens === null || integer(budget.maxOutputTokens, 1, 100000000), 'Declare a reported output-token budget or explicit null. A numeric budget requires mapped token counts on every response.')
    invariant(Array.isArray(workflow.stages) && workflow.stages.length > 0 && workflow.stages.length <= 32, 'Declare 1–32 workflow stages.')
    const stages = new Map()
    for (const stage of workflow.stages) {
      keys(stage, ['id', 'instructions', 'includeTaskPrompt', 'includeTaskInput', 'parents', 'allowedTools', 'timeoutMs', 'next', 'resultPath'], 'Workflow stage')
      invariant(ID.test(stage.id) && !stages.has(stage.id), 'Workflow stages need distinct lowercase identifiers.'); stages.set(stage.id, stage)
      keys(stage.instructions, ['system', 'developer', 'user'], 'Stage instructions')
      invariant(['system', 'developer'].every(role => stage.instructions[role] === null || typeof stage.instructions[role] === 'string') && typeof stage.instructions.user === 'string', 'Stage instructions declare exact system, developer and user text; no inherited hidden context is inferred.')
      invariant(typeof stage.includeTaskPrompt === 'boolean' && typeof stage.includeTaskInput === 'boolean', 'Declare task prompt and input visibility for each stage.')
      invariant(Array.isArray(stage.parents) && stage.parents.length <= 32, 'Declare the parent outputs passed to each stage.')
      for (const parent of stage.parents) { keys(parent, ['stageId', 'path'], 'Parent context'); invariant(ID.test(parent.stageId) && path(parent.path), 'Parent context needs a stage and a literal JSON path.'); }
      invariant(new Set(stage.parents.map(parent => parent.stageId)).size === stage.parents.length, 'Parent context stages must be distinct.')
      invariant(Array.isArray(stage.allowedTools) && stage.allowedTools.length <= 32 && stage.allowedTools.every(name => ID.test(name)) && new Set(stage.allowedTools).size === stage.allowedTools.length, 'Declare distinct allowed tool names for each stage.')
      invariant(integer(stage.timeoutMs, 1, spec.protocol.timeoutMs), 'A stage timeout must fit within the attempt timeout.')
      invariant(path(stage.resultPath), 'A terminal result uses a literal JSON path into that stage output.')
      keys(stage.next, ['branches', 'otherwise'], 'Stage transition')
      invariant(Array.isArray(stage.next.branches) && stage.next.branches.length <= 16, 'Declare at most 16 ordered equality branches.')
      for (const branch of stage.next.branches) { keys(branch, ['path', 'equals', 'to'], 'Workflow branch'); invariant(path(branch.path) && Object.hasOwn(branch, 'equals'), 'Branches compare a literal output path with frozen JSON.'); canonical(branch.equals); }
      invariant([...stage.next.branches, { to: stage.next.otherwise }].every(branch => branch.to === null || ID.test(branch.to)), 'A transition names the next stage or explicit null to select this stage result.')
    }
    invariant(stages.has(workflow.entry), 'The entry stage is missing.')
    const visiting = new Set(), visited = new Set(), order = []
    const visit = id => {
      invariant(stages.has(id), 'A workflow transition names a missing stage.')
      invariant(!visiting.has(id), 'Version 1 workflow graphs must be acyclic.')
      if (visited.has(id)) return
      visiting.add(id); for (const next of targets(stages.get(id))) visit(next)
      visiting.delete(id); visited.add(id); order.unshift(id)
    }
    visit(workflow.entry); invariant(visited.size === stages.size, 'Every declared workflow stage must be reachable.')
    const dominators = new Map(), lengths = new Map()
    for (const id of order) {
      const predecessors = workflow.stages.filter(stage => targets(stage).includes(id)).map(stage => stage.id)
      const common = id === workflow.entry ? new Set() : new Set([...dominators.get(predecessors[0])].filter(parent => predecessors.every(previous => dominators.get(previous).has(parent))))
      invariant(stages.get(id).parents.every(parent => common.has(parent.stageId)), 'Parent context must come from a completed ancestor on every route to this stage.')
      common.add(id); dominators.set(id, common); lengths.set(id, 1 + Math.max(0, ...predecessors.map(previous => lengths.get(previous))))
    }
    invariant(Math.max(...lengths.values()) <= budget.maxCalls, 'The declared call budget must cover the longest frozen route.')
  }
  for (const condition of spec.conditions) {
    if (condition.workflowId === undefined) continue
    const workflow = workflowFor(spec, condition)
    invariant(workflow, `${condition.id}: unknown workflow.`)
    const tools = condition.collection?.tools || []
    invariant(tools.every(tool => object(tool) && ID.test(tool.name)) && new Set(tools.map(tool => tool.name)).size === tools.length, 'Workflow tools need distinct names in the condition collection controls.')
    invariant(workflow.stages.every(stage => stage.allowedTools.every(name => tools.some(tool => tool.name === name))), 'Every allowed workflow tool must be declared in the condition collection controls.')
    if (condition.adapter.kind === 'replay') invariant(condition.adapter.mode === 'envelope' && object(condition.adapter.workflowResponses), 'Workflow replay needs envelope mode and explicit task/stage response fixtures.')
  }
  invariant(plan.workflows.every(workflow => spec.conditions.some(condition => condition.workflowId === workflow.id)), 'Every workflow must be assigned to a condition.')
  invariant(bytes(plan) <= 2 * 1024 * 1024, 'The workflow plan exceeds 2 MiB.')
}

export async function compileWorkflows(spec) {
  if (!spec.workflowPlan) return null
  return { version: 1, plans: await Promise.all(spec.workflowPlan.workflows.map(async workflow => ({ id: workflow.id, sha256: await sha256(canonical(workflow)) }))),
    execution: 'The runner follows one sequential route through an acyclic graph, taking the first matching equality branch or the declared fallback',
    selection: 'The terminal stage resultPath selects the answer before grading; every stage is retained',
    context: 'Each stage receives a fresh adapter request containing only declared task visibility and ancestor output projections; private expected values and grades are excluded',
    tools: 'Allowed tool definitions are sent to the adapter. Reported action logs are checked against the allowlist and budget; opaque external tool access is not independently enforced',
    failure: 'Any stage failure, policy violation, cancellation or interruption halts the study. Explicit recovery closes uncertain attempts without redrawing them' }
}
export function workflowProjectFiles(project) {
  if (!project.workflows) return {}
  return { 'workflows/plan.json': JSON.stringify(project.spec.workflowPlan, null, 2) + '\n', 'workflows/contract.json': JSON.stringify(project.workflows, null, 2) + '\n' }
}
export function collectionRequest(project, condition, task, trial, attempt) {
  return { version: 1, projectSha256: project.sha256, trial, attempt, prompt: task.compiled.text, input: task.input ?? null, model: condition.model || null,
    ...(project.spec.observationPlan && condition.collection ? { collection: condition.collection } : {}) }
}
export function newWorkflowState(project, trial, attempt) {
  const { id, taskId, conditionId, replicate } = trial
  trial = { id, taskId, conditionId, replicate }
  const condition = project.spec.conditions.find(row => row.id === trial.conditionId), workflow = workflowFor(project.spec, condition)
  return workflow ? { project, trial, attempt, condition, task: project.tasks.find(row => row.id === trial.taskId), workflow,
    next: workflow.entry, active: null, stages: [], failed: false, responseBytes: 0, toolCalls: 0, outputTokens: 0, selectedStageId: null } : null
}
export function workflowRequest(state) {
  const stage = state.workflow.stages.find(row => row.id === state.next)
  invariant(stage && !state.active && !state.failed, 'The workflow cannot dispatch another stage.')
  const parents = stage.parents.map(parent => {
    const prior = state.stages.find(row => row.start.stageId === parent.stageId), value = at(prior?.finish?.response?.output, parent.path)
    invariant(prior?.finish?.status === 'completed' && value.found, 'A declared parent output path is unavailable; context cannot be guessed.')
    return { stageId: parent.stageId, path: parent.path, output: value.value }
  })
  const request = collectionRequest(state.project, state.condition, state.task, state.trial, state.attempt)
  request.prompt = canonical({ version: 1, instruction: stage.instructions.user, taskPrompt: stage.includeTaskPrompt ? state.task.compiled.text : null, parents })
  request.input = stage.includeTaskInput ? state.task.input ?? null : null
  const allowedTools = (state.condition.collection?.tools || []).filter(tool => stage.allowedTools.includes(tool.name))
  request.collection = { ...(state.condition.collection || {}), instructions: { system: stage.instructions.system, developer: stage.instructions.developer }, tools: allowedTools,
    contextConstruction: 'frozen-workflow-projection', sessionIsolation: 'fresh-call-requested' }
  request.workflow = { version: 1, id: state.workflow.id, planSha256: state.project.workflows.plans.find(plan => plan.id === state.workflow.id).sha256,
    purpose: state.workflow.purpose, stageId: stage.id, step: state.stages.length + 1, timeoutMs: stage.timeoutMs,
    remainingToolCalls: state.workflow.budgets.maxToolCalls - state.toolCalls,
    remainingOutputTokens: state.workflow.budgets.maxOutputTokens === null ? null : state.workflow.budgets.maxOutputTokens - state.outputTokens }
  invariant(bytes(request) <= state.workflow.budgets.maxRequestBytes, 'The workflow request exceeds its frozen byte budget; no context was truncated.')
  return request
}
const stageObservation = (state, response) => observeResponse(state.project.spec, { ...state.condition, collection: state.active?.start.request.collection || state.condition.collection }, response)
function outcome(state, stage, response) {
  invariant(object(response) && Object.hasOwn(response, 'output'), 'A workflow stage returned no output.')
  const log = response.workflow?.toolCalls
  invariant(Array.isArray(log) && log.length <= 1024, 'Every workflow response needs an explicit reported workflow.toolCalls log, including an empty array when none were reported.')
  const ids = new Set()
  for (const call of log) {
    keys(call, ['id', 'name', 'arguments', 'result', 'status'], 'Reported tool call')
    invariant(typeof call.id === 'string' && call.id.length > 0 && !ids.has(call.id) && stage.allowedTools.includes(call.name) && ['completed', 'failed'].includes(call.status) && Object.hasOwn(call, 'arguments') && Object.hasOwn(call, 'result'), 'A reported tool call is missing evidence, duplicated or outside the stage allowlist.')
    ids.add(call.id); canonical(call)
  }
  const observed = stageObservation(state, response)
  invariant(observed.eligible, 'A workflow stage violates the frozen observation policy: ' + observed.ineligibility.join(', ') + '.')
  const responseBytes = state.responseBytes + bytes(response), toolCalls = state.toolCalls + log.length
  invariant(responseBytes <= state.workflow.budgets.maxResponseBytes, 'Workflow retained responses exceed the frozen total byte budget.')
  invariant(toolCalls <= state.workflow.budgets.maxToolCalls, 'Workflow reported tool calls exceed the frozen total budget.')
  const tokens = observed.usage.outputTokens, outputTokens = state.outputTokens + (tokens.status === 'observed' ? tokens.value : 0)
  invariant(state.workflow.budgets.maxOutputTokens === null || tokens.status === 'observed' && outputTokens <= state.workflow.budgets.maxOutputTokens, 'Workflow output tokens are unavailable or exceed the frozen reported-token budget.')
  const match = stage.next.branches.find(branch => { const value = at(response.output, branch.path); return value.found && canonical(value.value) === canonical(branch.equals) })
  const next = match ? match.to : stage.next.otherwise, result = next === null ? at(response.output, stage.resultPath) : null
  invariant(next !== null || result.found, 'The terminal stage result path is unavailable.')
  return { next, responseBytes, toolCalls, outputTokens, selected: result?.value, observed }
}
export function acceptWorkflowEvent(state, event) {
  invariant(state && event.trialId === state.trial.id && event.attempt === state.attempt, 'The stage event has no bound workflow attempt.')
  invariant(!state.failed && state.next !== null, 'A halted or terminal workflow cannot append another stage.')
  if (event.type === 'workflow-started') {
    invariant(!state.active && event.stageId === state.next && event.step === state.stages.length + 1 && event.step <= state.workflow.budgets.maxCalls, 'Workflow stages must follow the frozen route without duplicate calls.')
    invariant(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) && canonical(event.request) === canonical(workflowRequest(state)), 'The workflow request differs from its frozen context, stage or condition.')
    const record = { start: event, finish: null }; state.stages.push(record); state.active = record
  } else {
    invariant(event.type === 'workflow-finished' && state.active && event.stageId === state.active.start.stageId && event.step === state.active.start.step, 'A workflow completion has no unique matching start.')
    invariant(['completed', 'failed', 'cancelled'].includes(event.status) && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0, 'A workflow completion needs a valid outcome and duration.')
    const stage = state.workflow.stages.find(row => row.id === event.stageId)
    if (event.status === 'completed') {
      const result = outcome(state, stage, event.response)
      invariant(canonical(result.observed) === canonical(event.observations), 'Stage accounting disagrees with its retained response.')
      Object.assign(state, { next: result.next, responseBytes: result.responseBytes, toolCalls: result.toolCalls, outputTokens: result.outputTokens })
      if (result.next === null) { state.selectedStageId = stage.id; state.selectedResponse = { ...event.response, output: result.selected } }
    } else {
      invariant(typeof event.reason === 'string' && event.reason.length > 0, 'A failed workflow stage needs its retained reason.')
      invariant(canonical(stageObservation(state, event.response)) === canonical(event.observations), 'Failed stage accounting disagrees with its retained evidence.')
      state.failed = true
    }
    state.active.finish = event; state.active = null
  }
}
export function workflowEvidence(state) {
  return state ? { version: 1, id: state.workflow.id, purpose: state.workflow.purpose, selectedStageId: state.selectedStageId, stages: structuredClone(state.stages) } : undefined
}

export async function executeWorkflow(state, { adapter, write, signal, settle, measure, truncate = () => {}, isCancelled = () => signal.aborted, now = () => Date.now(), monotonic = () => performance.now() }) {
  const persist = async event => {
    let row
    try { row = await write(event) } catch (error) { throw Object.assign(error, { keepLock: true }) }
    acceptWorkflowEvent(state, row)
  }
  while (state.next !== null) {
    signal.throwIfAborted()
    const request = workflowRequest(state), stage = state.workflow.stages.find(row => row.id === state.next), step = request.workflow.step
    await persist({ type: 'workflow-started', trialId: state.trial.id, attempt: state.attempt, stageId: stage.id, step, at: new Date(now()).toISOString(), request })
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason || new Error('Workflow cancelled.'))
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new Error('Workflow stage time budget exceeded.')), stage.timeoutMs), start = monotonic()
    let response, error, pending, late, removeAbort = () => {}
    try {
      controller.signal.throwIfAborted()
      const aborted = new Promise((_, reject) => { const stop = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', stop, { once: true }); removeAbort = () => controller.signal.removeEventListener('abort', stop) })
      pending = Promise.resolve().then(() => adapter({ project: state.project, condition: state.condition, task: state.task, trial: state.trial, attempt: state.attempt, request, signal: controller.signal, ...(measure ? { measure } : {}) }))
      pending.then(value => { late = value }, failure => { if (failure?.evidence) late = failure.evidence })
      response = JSON.parse(canonical(await Promise.race([pending, aborted])))
      controller.signal.throwIfAborted(); outcome(state, stage, response)
    } catch (failure) { error = failure }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); removeAbort()
      if (controller.signal.aborted) {
        // An uncooperative child Promise may outlive this stage. Close its
        // measured interval before the collection parent can finish.
        truncate()
        try { if (await settle() === true) await Promise.allSettled([pending].filter(Boolean)) }
        catch (failure) { throw Object.assign(failure, { keepLock: true }) }
      }
    }
    if (response === undefined && (error?.evidence !== undefined || late !== undefined)) response = JSON.parse(canonical(error?.evidence ?? late))
    const event = { type: 'workflow-finished', trialId: state.trial.id, attempt: state.attempt, stageId: stage.id, step,
      status: error ? isCancelled() ? 'cancelled' : 'failed' : 'completed', elapsedMs: Math.max(0, monotonic() - start),
      ...(response !== undefined ? { response } : {}), ...(error ? { reason: error?.message || String(error) } : {}),
      observations: stageObservation(state, response) }
    await persist(event)
    if (error) throw error
  }
  return state.selectedResponse
}

export function workflowAnalysis(project, events) {
  if (!project.workflows) return null
  const finishes = new Map(), ends = new Map(), key = event => event.trialId + ':' + event.attempt
  for (const event of events) {
    if (event.type === 'workflow-finished') finishes.set(key(event) + ':' + event.step, event)
    if (event.type === 'finished') ends.set(key(event), event)
  }
  const stages = events.filter(event => event.type === 'workflow-started').map(start => {
    const finish = finishes.get(key(start) + ':' + start.step), end = ends.get(key(start))
    return { trialId: start.trialId, attempt: start.attempt, workflowId: start.request.workflow.id, stageId: start.stageId, step: start.step,
      status: finish?.status || 'interrupted', elapsedMs: finish?.elapsedMs ?? null, selectedForGrade: end?.workflow?.selectedStageId === start.stageId && end.status === 'completed',
      request: start.request, response: finish?.response ?? null, observations: finish?.observations ?? null, reason: finish?.reason ?? null }
  })
  // Durable journals sort JSON object keys. Normalize the derived artifact so
  // initial reports and reports rebuilt after a restart have identical bytes.
  return JSON.parse(canonical({ version: 1, contract: project.workflows, plan: project.spec.workflowPlan, stages,
    limitations: [project.workflows.tools, 'A stage is one adapter call. External adapters must implement the requested fresh context and expose tool actions; hidden provider work and hidden tool use remain unobserved.', 'Byte and reported resource budgets stop subsequent calls after a violation; already incurred external work cannot be undone. Stage and attempt deadlines bound owned transports.'] }))
}
