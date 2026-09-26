import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { analyze, gradeResponse, verifyProject, RUNTIME_FILES, LEGACY_RUNTIME_FILES, runtimeFilesFor } from './study.mjs'
import { modernSchema, runtimeFilesForVersion } from './study-schema.mjs'
import { decodeInformationResponse, gradeInterpretations, informationDisposition } from './information.mjs'
import { interpretationObservation } from './conventions.mjs'
import { attemptObservations, createObservationMeter, measuredPhase, observeResponse, validateAttemptObservations } from './observations.mjs'
import { acceptWorkflowEvent, collectionRequest, executeWorkflow, newWorkflowState, workflowEvidence } from './workflow.mjs'
import { selectedInputGate, assertSelectedInputQualification, verifySelectedInputQualification, verifyQualificationJournal, qualificationPreparationLedger, SELECTED_INPUT_PREPARATION_LIMITS } from './requirements.mjs'
import { executeResourcePlan, assertResourceExecution, verifyResourceExecution, resourceConformance, assertResourceConformance, verifyResourceConformance } from './resource-effects.mjs'
import { resourcePreparationLedger, RESOURCE_PREPARATION_LIMITS } from './templates.mjs'
import { assertCollectionAdmission } from './readiness.mjs'
import { benchmarkFor } from './registry.mjs'

const resourceStudy = project => project.spec.protocol.grading.kind === 'resource-action-plan'
const templatePreparation = event => ['template-qualified', 'template-requalified', 'template-preparation-failed'].includes(event.type)
const templateIntent = event => event.type === 'template-preparation-started'
const selectedPreparation = event => ['qualification-started', 'qualification', 'qualification-failed'].includes(event.type)
const utf8Bytes = value => new TextEncoder().encode(value).length
const eventEvidenceBytes = event => utf8Bytes(JSON.stringify({ events: [event] }, null, 2))
const resourceBinding = (project, event) => ({ projectSha256: project.sha256, trialId: event.trialId, attempt: event.attempt })
const resourceOutput = (events, finished) => finished?.response && Object.hasOwn(finished.response, 'output') ? finished.response.output : events.find(event => event.type === 'resource-prepared')?.output
export async function verifyResourceJournal(project, events) {
  if (!resourceStudy(project)) return
  const packets = project.tasks.map(task => task.resource)
  for (const event of events.filter(event => event.type === 'template-qualified')) await verifyResourceConformance(event.record, project.spec.runtimeSources, packets)
  for (const start of events.filter(event => event.type === 'started')) {
    const own = events.filter(event => event.trialId === start.trialId && event.attempt === start.attempt)
    const records = own.filter(event => event.type.startsWith('resource-')), finished = own.find(event => event.type === 'finished')
    if (!records.length) continue
    const task = project.tasks.find(task => task.id === project.schedule.find(trial => trial.id === start.trialId).taskId)
    await verifyResourceExecution(task.resource, resourceOutput(records, finished), records, { binding: resourceBinding(project, start), allowPartial: finished?.status !== 'completed' })
  }
}

function validGrade(task, grade) {
  return task.audit?.referenceVerdict === null ? grade?.passed === null && grade.score === null && grade.referenceEligible === false
    : typeof grade?.passed === 'boolean' && Number.isFinite(grade.score)
}

export function customGradeResult(grade, message) {
  invariant(object(grade) && typeof grade.passed === 'boolean' && Number.isFinite(grade.score), message)
  invariant(!Object.hasOwn(grade, 'process'), 'Custom graders must not return process; that field is reserved for the host execution receipt.')
  invariant(!Object.hasOwn(grade, 'classification') || typeof grade.classification === 'string' && grade.classification.trim().length > 0 && grade.classification.length <= 128,
    'A custom classification must be a nonempty string of at most 128 characters, so distinct categories remain distinct in analysis.')
  // Every scientific extension field must be finite JSON, like the score.
  canonical(grade)
  return grade
}
export function recordedCustomGrade(event) {
  invariant(object(event.grade), 'The recorded custom grade has no valid result.')
  const { process: receipt, ...grade } = event.grade
  customGradeResult(grade, 'The recorded custom grade has no valid result.')
  if (Object.hasOwn(event.grade, 'process')) {
    invariant(object(receipt) && typeof receipt.stdout === 'string' && typeof receipt.stderr === 'string' && receipt.exitCode === 0 && receipt.signal === null,
      'The recorded custom grade has no successful process receipt.')
    let retained
    try { retained = JSON.parse(receipt.stdout) } catch {}
    invariant(object(retained) && Object.hasOwn(retained, 'output') && canonical(retained.output) === canonical(grade),
      `The recorded custom grade disagrees with its retained process output: ${event.trialId}.`)
  }
  // Portable validation establishes consistency with retained raw output.
  // Only the CLI can additionally execute the pinned Node module to regrade.
  return grade
}

export async function replayAdapter({ condition, task, signal, request }) {
  signal.throwIfAborted()
  if (request?.workflow) {
    const stages = condition.adapter.workflowResponses?.[task.id]
    invariant(stages && Object.hasOwn(stages, request.workflow.stageId), `No recorded workflow response for ${task.id}/${request.workflow.stageId}.`)
    return structuredClone(stages[request.workflow.stageId])
  }
  invariant(Object.hasOwn(condition.adapter.responses, task.id), `No recorded response for ${task.id}.`)
  if (condition.adapter.mode === 'envelope') return condition.adapter.responses[task.id]
  return { output: condition.adapter.responses[task.id], usage: null }
}
export function validateJournal(project, events, { openedArchive = false } = {}) {
  invariant(Array.isArray(events), 'The attempt journal must be an array.')
  if (resourceStudy(project)) invariant(events.reduce((sum, event) => sum + new TextEncoder().encode(canonical(event)).length + 1, 0) <= project.experimentTemplate.limits.evidenceBytes,
    'The resource journal exceeds its frozen cumulative evidence limit.')
  const selectedGate = selectedInputGate(project), modernPreparation = events.some(event => event.type === 'qualification-started')
  if (modernPreparation) {
    invariant(events.reduce((sum, event) => sum + utf8Bytes(canonical(event)) + 1, 0) <= SELECTED_INPUT_PREPARATION_LIMITS.journalBytes, 'The selected-input journal exceeds its cumulative evidence byte limit.')
    invariant(events.reduce((sum, event) => sum + eventEvidenceBytes(event), 0) <= SELECTED_INPUT_PREPARATION_LIMITS.eventEvidenceBytes, 'Selected-input event evidence exceeds its serialized byte limit.')
  }
  const trials = new Map(project.schedule.map((row, index) => [row.id, { ...row, index }])), tasks = new Map(project.tasks.map(row => [row.id, row]))
  const starts = new Map(), ends = new Set(), completed = new Set(), counts = new Map()
  let active = null, lastTrialIndex = -1, halted = false, workflow = null, qualified = false, templateQualified = false, templateRecord = null, preparationCount = 0, resourceEvents = [], resourceBudgetCharge = 0
  let selectedActive = null, selectedCount = 0, selectedBudgetCharge = 0, selectedUnknownCharge = false, selectedHalted = false
  let templateActive = null, modernTemplateSeen = false
  for (let i = 0; i < events.length; i++) {
    const event = events[i], key = `${event?.trialId}:${event?.attempt}`
    invariant(event?.seq === i + 1 && event.projectSha256 === project.sha256, 'The attempt journal has an invalid sequence or project binding.')
    if (templateIntent(event) || templatePreparation(event)) {
      invariant(resourceStudy(project) && active === null && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)), 'Template qualification must precede collection outside any active attempt.')
      const common = ['type', 'seq', 'projectSha256', 'at']
      if (templateIntent(event)) {
        invariant(!templateActive && !halted, 'A prior resource preparation or episode remains unresolved; new preparation is refused.')
        invariant(resourceBudgetCharge < project.spec.protocol.maxDurationMs, 'Resource preparation began after retained charges exhausted the frozen study time budget.')
        invariant(++preparationCount <= project.schedule.length + 1, 'The resource experiment reached its frozen preparation-count limit.')
        invariant(Object.keys(event).every(key => [...common, 'timeoutMs', 'reservedMs'].includes(key)), 'Resource preparation intent has unsupported evidence fields.')
        invariant(Number.isFinite(event.timeoutMs) && event.timeoutMs > 0 && event.timeoutMs <= RESOURCE_PREPARATION_LIMITS.timeoutMs
          && event.timeoutMs <= project.spec.protocol.maxDurationMs - resourceBudgetCharge && event.reservedMs === event.timeoutMs,
        'Resource preparation intent has an invalid deadline or recovery reservation.')
        templateActive = event; modernTemplateSeen = true; templateQualified = false; continue
      }
      const paired = event.preparationSeq !== undefined
      if (paired) {
        invariant(templateActive && event.preparationSeq === templateActive.seq, 'Resource preparation completion has no matching durable intent.')
        if (event.type === 'template-preparation-failed' && event.status === 'interrupted')
          invariant(event.elapsedMs === null && event.budgetChargeMs === templateActive.reservedMs, 'Interrupted resource preparation must charge its complete reservation without invented elapsed time.')
        else invariant(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.budgetChargeMs === event.elapsedMs, 'Settled resource preparation requires measured elapsed time and the same budget charge.')
      } else {
        invariant(!templateActive && !modernTemplateSeen, 'Legacy resource receipts cannot replace a paired preparation result or follow modern preparation.')
        invariant(resourceBudgetCharge < project.spec.protocol.maxDurationMs, 'Resource preparation began after retained charges exhausted the frozen study time budget.')
        invariant(++preparationCount <= project.schedule.length + 1, 'The resource experiment reached its frozen preparation-count limit.')
        invariant(Number.isFinite(event.budgetChargeMs) && event.budgetChargeMs >= 0, 'Legacy resource preparation has an invalid measured time charge.')
      }
      const allowed = [...common, 'budgetChargeMs', ...(paired ? ['preparationSeq', 'elapsedMs'] : []),
        ...(event.type === 'template-qualified' ? ['record'] : event.type === 'template-requalified' ? ['recordSha256'] : ['reason', ...(paired ? ['status'] : [])])]
      invariant(Object.keys(event).every(key => allowed.includes(key)), 'Template preparation has unsupported evidence fields.')
      if (event.type === 'template-qualified') {
        invariant(!templateRecord, 'Retain one full template proof; later matching qualification uses a compact receipt.')
        assertResourceConformance(event.record, project.spec.runtimeSources, project.tasks.map(task => task.resource)); templateRecord = event.record; templateQualified = true
      } else if (event.type === 'template-requalified') {
        invariant(templateRecord && event.recordSha256 === templateRecord.sha256, 'Repeated template qualification must bind the retained source and case proof.'); templateQualified = true
      } else {
        invariant(!paired || ['failed', 'cancelled', 'timeout', 'interrupted'].includes(event.status), 'Failed resource preparation needs a known disposition.')
        invariant(typeof event.reason === 'string' && event.reason.length > 0 && event.reason.length <= 4096, 'Failed preparation needs a bounded diagnostic reason.'); templateQualified = false
      }
      resourceBudgetCharge += event.budgetChargeMs; templateActive = null
      continue
    }
    if (selectedPreparation(event)) {
      invariant(active === null && selectedGate && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)), 'Qualification must precede collection, outside any active attempt.')
      const common = ['type', 'seq', 'projectSha256', 'at']
      if (event.type === 'qualification-started') {
        invariant(!selectedActive && !selectedHalted && !halted, 'A prior preparation or retained response has not safely completed; new qualification is refused.')
        invariant(!selectedUnknownCharge, 'Legacy qualification has unavailable preparation charges; no new preparation can begin in this journal.')
        invariant(selectedBudgetCharge < project.spec.protocol.maxDurationMs, 'Qualification began after retained charges exhausted the frozen study time budget.')
        invariant(++selectedCount <= project.spec.protocol.maxTotalAttempts + 1, 'The selected-input preparation-count limit is exhausted.')
        invariant(Object.keys(event).every(key => [...common, 'timeoutMs', 'settlementMs', 'reservedMs'].includes(key)), 'Qualification intent has unsupported fields.')
        invariant(Number.isFinite(event.timeoutMs) && event.timeoutMs > 0 && event.timeoutMs <= selectedGate.timeoutMs
          && event.timeoutMs <= project.spec.protocol.maxDurationMs - selectedBudgetCharge
          && event.settlementMs === SELECTED_INPUT_PREPARATION_LIMITS.settlementMs && event.reservedMs === event.timeoutMs + event.settlementMs,
        'Qualification intent has an invalid deadline or recovery reservation.')
        selectedActive = event; qualified = false; continue
      }
      if (event.type === 'qualification' && event.preparationSeq === undefined) {
        invariant(!selectedActive && !modernPreparation, 'A legacy qualification receipt cannot replace a paired preparation result.')
        invariant(Object.keys(event).every(key => [...common, 'record'].includes(key)), 'Legacy qualification cannot assert unpaired timing fields.')
        assertSelectedInputQualification(project, event.record); qualified = true; selectedUnknownCharge = true; continue
      }
      invariant(selectedActive && event.preparationSeq === selectedActive.seq, 'Qualification completion has no matching preparation intent.')
      const fields = [...common, 'preparationSeq', 'elapsedMs', 'budgetChargeMs', ...(event.type === 'qualification' ? ['record'] : ['status', 'reason', 'diagnostic'])]
      invariant(Object.keys(event).every(key => fields.includes(key)), 'Qualification completion has unsupported fields.')
      if (event.type === 'qualification-failed' && event.status === 'interrupted') {
        invariant(event.elapsedMs === null && event.budgetChargeMs === selectedActive.reservedMs, 'Interrupted preparation must reserve its complete timeout and settlement allowance without invented elapsed time.')
        selectedHalted = true
      } else invariant(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.budgetChargeMs === event.elapsedMs, 'Settled preparation needs its complete measured elapsed time and matching budget charge.')
      if (event.type === 'qualification') {
        invariant(utf8Bytes(canonical(event)) <= SELECTED_INPUT_PREPARATION_LIMITS.proofBytes, 'The full qualification receipt exceeds its frozen proof byte limit.')
        assertSelectedInputQualification(project, event.record); qualified = true
      } else {
        invariant(['failed', 'cancelled', 'timeout', 'interrupted'].includes(event.status) && typeof event.reason === 'string' && event.reason.length > 0 && event.reason.length <= 4096, 'Failed preparation needs a known disposition and bounded reason.')
        if (event.diagnostic !== undefined) invariant(object(event.diagnostic) && Object.keys(event.diagnostic).every(key => ['bytes', 'sha256', 'reason'].includes(key))
          && Number.isSafeInteger(event.diagnostic.bytes) && event.diagnostic.bytes >= 0 && /^[a-f0-9]{64}$/.test(event.diagnostic.sha256)
          && typeof event.diagnostic.reason === 'string' && event.diagnostic.reason.length <= 256, 'Rejected qualification needs bounded diagnostic bindings.')
        qualified = false
      }
      selectedBudgetCharge += event.budgetChargeMs; selectedActive = null; continue
    }
    invariant(trials.has(event.trialId), 'The attempt journal has an invalid trial binding.')
    invariant(Number.isSafeInteger(event.attempt) && event.attempt > 0 && event.attempt <= project.spec.protocol.maxAttemptsPerTrial, 'The attempt journal has an invalid attempt number.')
    if (event.type === 'started') {
      if (modernSchema(project)) {
        const purpose = project.spec.executionPlan.purpose
        invariant(event.readinessSha256 === project.readiness.sha256 && event.executionPurpose === purpose, 'The attempt has a different readiness contract or execution purpose.')
        // A retained row establishes its frozen operation contract, not an
        // authenticated identity for the historical transport implementation.
        //
        // The invariant above is the binding one: it ties this journal to THIS
        // project by readiness digest and purpose, and it holds for every caller.
        // The admission below asks a different question -- would the CURRENT build
        // admit this collection -- and re-derives readiness to answer it. For a
        // project opened from an archive some other build froze, that question is
        // not the one being asked and its answer is always no, because any change
        // to readiness output re-identifies every earlier frozen project. Skipped
        // only for that caller, and only after the binding check has passed.
        if (!openedArchive) assertCollectionAdmission(project, { operation: purpose === 'experiment' ? 'collect' : purpose === 'apparatus-development' ? 'apparatus-development' : 'diagnostic-replay', canonicalReplay: true })
      }
      invariant(!resourceStudy(project) || templateQualified && !templateActive, 'Resource collection started without the required settled template qualification.')
      invariant(!resourceStudy(project) || resourceBudgetCharge < project.spec.protocol.maxDurationMs, 'Resource collection started after retained charges exhausted the frozen study time budget.')
      invariant(!selectedInputGate(project) || qualified, 'Collection started without the required selected-input qualification.')
      invariant(!selectedGate || !selectedActive && !selectedHalted, 'Collection cannot start while preparation remains unresolved.')
      invariant(!selectedGate || !modernPreparation || selectedBudgetCharge < project.spec.protocol.maxDurationMs, 'Collection started after retained preparation and attempt charges exhausted the frozen study time budget.')
      invariant(!halted, 'A failed retained response halted collection; the journal cannot redraw it or continue collection under the same frozen project.')
      invariant(!starts.has(key), 'The attempt journal contains a duplicate start.')
      invariant(!completed.has(event.trialId), 'A completed trial cannot start again.')
      invariant(active === null, 'A previous attempt has no terminal outcome.')
      const trial = trials.get(event.trialId)
      invariant(trial.index >= lastTrialIndex, 'The attempt journal changed the frozen trial order.')
      invariant(event.promptSha256 === tasks.get(trial.taskId).compiled.promptSha256, 'The attempt is bound to a different prompt.')
      invariant(event.attempt === 1 + (counts.get(event.trialId) || 0), 'Attempt numbers must be contiguous.')
      invariant(starts.size < project.spec.protocol.maxTotalAttempts, 'The journal exceeds the total attempt budget.')
      invariant(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)), 'The attempt has no valid start timestamp.')
      counts.set(event.trialId, event.attempt); active = key; lastTrialIndex = trial.index
      starts.set(key, event)
      workflow = newWorkflowState(project, trial, event.attempt)
      resourceEvents = []
    } else if (event.type.startsWith('resource-')) {
      invariant(resourceStudy(project) && active === key, 'A resource observation needs its active generated experiment attempt.')
      resourceEvents.push(event)
    } else if (['workflow-started', 'workflow-finished'].includes(event.type)) {
      invariant(active === key, 'A stage has no active parent attempt.')
      acceptWorkflowEvent(workflow, event)
    } else {
      invariant(event.type === 'finished' && starts.has(key) && !ends.has(key), 'The attempt journal contains a duplicate or unbound completion.')
      invariant(['completed', 'failed', 'cancelled', 'interrupted'].includes(event.status), 'The attempt journal has an unknown outcome.')
      invariant(event.status === 'interrupted' ? event.elapsedMs === null && event.budgetChargeMs === project.spec.protocol.timeoutMs : Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.budgetChargeMs === undefined, 'The attempt journal has an invalid duration or recovery budget charge.')
      if (resourceStudy(project)) resourceBudgetCharge += event.budgetChargeMs ?? event.elapsedMs
      if (selectedGate) selectedBudgetCharge += event.budgetChargeMs ?? event.elapsedMs
      if (workflow) {
        invariant(canonical(event.workflow) === canonical(workflowEvidence(workflow)), 'The attempt workflow evidence differs from its stage journal.')
        if (event.status === 'completed') invariant(workflow.next === null && !workflow.active && !workflow.failed && canonical(event.response) === canonical(workflow.selectedResponse), 'A workflow answer must come from the frozen terminal selection before grading.')
        else invariant(event.status === 'interrupted' || !workflow.active, 'An active stage needs a terminal record before the attempt can finish.')
      } else invariant(event.workflow === undefined, 'Workflow evidence needs a frozen condition workflow.')
      validateAttemptObservations(project, trials.get(event.trialId), event)
      if (resourceStudy(project) && resourceEvents.length) {
        const task = tasks.get(trials.get(event.trialId).taskId)
        const verified = assertResourceExecution(task.resource, resourceOutput(resourceEvents, event), resourceEvents,
          { binding: resourceBinding(project, event), allowPartial: event.status !== 'completed' })
        if (event.status === 'completed') invariant(canonical(verified.grade) === canonical(event.grade), 'The resource grade differs from independently reconstructed state observations.')
      }
      if (event.status === 'completed') {
        const trial = trials.get(event.trialId), task = tasks.get(trial.taskId)
        invariant(validGrade(task, event.grade) && event.response && Object.hasOwn(event.response, 'output'), 'The completed attempt has no valid response and grade.')
        invariant(!resourceStudy(project) || resourceEvents.length > 0, 'A resource result needs its retained state observations and closure.')
        if (['exact', 'json', 'judge-audit'].includes(project.spec.protocol.grading.kind)) {
          invariant(canonical(gradeResponse(project, task, event.response.output)) === canonical(event.grade), 'The recorded grade disagrees with its retained response.')
        }
        if (project.spec.protocol.grading.kind === 'module') recordedCustomGrade(event)
        if (task.information) {
          interpretationObservation(task, event)
          if (project.spec.protocol.grading.kind === 'lean-python') {
            const decoded = decodeInformationResponse(task, event.response.output)
            if (decoded.behavior !== 'answer') invariant(canonical(informationDisposition(decoded)) === canonical(event.grade), 'The recorded information disposition disagrees with its retained response.')
            else if (Object.hasOwn(event.grade, 'trace')) {
              invariant(benchmarkFor(project.spec)?.matchesObservationProfile?.(event.grade.trace, !!task.compiled.operational) ?? Array.isArray(event.grade.trace), 'The retained native trace has the wrong observation profile for this task.')
              const expected = gradeInterpretations(task, event.grade.trace, 'json')
              invariant(Object.entries(expected).every(([key, value]) => canonical(value) === canonical(event.grade[key])), 'The recorded interpretation grade disagrees with its retained engine trace.')
            } else invariant(!event.grade.passed && ['no-program', 'format-violation', 'execution-timeout', 'execution-error', 'invalid-engine-result'].includes(event.grade.classification), 'An information answer needs a retained native trace or an explicit execution failure.')
          }
        }
        completed.add(event.trialId)
      }
      ends.add(key)
      if (workflow && event.status !== 'completed' || event.status === 'failed' && ['grading', 'extraction', 'observation'].includes(event.phase)) halted = true
      if (resourceStudy(project) && event.status !== 'completed') halted = true
      active = null
    }
  }
  return [...starts.entries()].filter(([key]) => !ends.has(key)).map(([, event]) => event)
}

// The browser fixture run and exported command use this same state machine.
// Durable I/O and external adapters are supplied by cli.mjs; no GUI is needed.
export async function runStudy(project, { events = [], append = async () => {}, adapter = replayAdapter,
  grade = gradeResponse, signal = new AbortController().signal, recover = false, now = () => Date.now(), monotonic = () => performance.now(), onEvent = () => {}, settle = async () => {}, recordResponse = async () => {}, runtime = null, qualify = null } = {}) {
  // Embedding callbacks receive an immutable private snapshot. A collector
  // must not alter the answer key, schedule or contract after verification.
  project = structuredClone(project)
  const immutable = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) immutable(child)
      Object.freeze(value)
    }
    return value
  }
  immutable(project)
  await verifyProject(project)
  events = structuredClone(events).map(immutable)
  await verifyQualificationJournal(project, events)
  await verifyResourceJournal(project, events)
  const unfinished = validateJournal(project, events)
  invariant(!events.some(event => event.type === 'finished' && event.workflow && event.status !== 'completed'), 'A workflow halted with retained stage evidence. Inspect and repair the apparatus in a new frozen project; resuming cannot redraw a partial workflow.')
  invariant(!resourceStudy(project) || !events.some(event => event.type === 'finished' && event.status !== 'completed'), 'A resource episode halted. Inspect its retained response and state observations; a new frozen project is required before further collection.')
  invariant(!events.some(event => event.type === 'finished' && event.status !== 'completed' && ['grading', 'extraction', 'observation'].includes(event.phase)), 'A retained response could not be graded or admitted by the frozen observation policy. Inspect and repair the apparatus before reusing those responses in a new frozen project; resuming cannot redraw a system answer.')
  invariant(!unfinished.length || recover, 'An attempt was interrupted. Inspect its raw records and explicitly recover before resuming.')
  const history = new Map()
  let totalStarts = 0
  let journalBytes = events.reduce((sum, event) => sum + new TextEncoder().encode(canonical(event)).length + 1, 0)
  let serializedEventBytes = events.reduce((sum, event) => sum + eventEvidenceBytes(event), 0)
  const selectedGate = selectedInputGate(project)
  const journalLimit = resourceStudy(project) ? project.experimentTemplate.limits.evidenceBytes : selectedGate ? SELECTED_INPUT_PREPARATION_LIMITS.journalBytes : Infinity
  invariant(!resourceStudy(project) && !events.some(event => event.type === 'qualification-started') || journalBytes <= journalLimit, 'The experiment journal exceeds its frozen cumulative evidence limit.')
  const remember = row => {
    if (row.type !== 'started' && row.type !== 'finished') return
    if (!history.has(row.trialId)) history.set(row.trialId, [])
    history.get(row.trialId).push(row)
    if (row.type === 'started') totalStarts++
  }
  for (const row of events) remember(row)
  const write = async event => {
    const row = immutable(structuredClone({ ...event, projectSha256: project.sha256, seq: events.length + 1 }))
    const bytes = resourceStudy(project) || selectedGate ? new TextEncoder().encode(canonical(row)).length + 1 : 0
    const serializedBytes = selectedGate ? eventEvidenceBytes(row) : 0
    invariant(journalBytes + bytes <= journalLimit, 'The experiment journal reached its frozen cumulative evidence limit. No further call or effect was dispatched.')
    invariant(!selectedGate || serializedEventBytes + serializedBytes <= SELECTED_INPUT_PREPARATION_LIMITS.eventEvidenceBytes, 'Selected-input event evidence reached its serialized byte limit before dispatch.')
    await append(row) // Never dispatch a call whose start could not be recorded.
    journalBytes += bytes; serializedEventBytes += serializedBytes; events.push(row); remember(row); onEvent(row); return row
  }
  const preparationLedger = qualificationPreparationLedger(project, events)
  const unresolvedPreparation = message => {
    const error = new Error(message); error.keepLock = true; error.qualificationUnsettled = true
    error.events = structuredClone(events); error.summary = analyze(project, events); return error
  }
  if (preparationLedger?.interrupted) throw unresolvedPreparation('Interrupted qualification has unresolved interpreter ownership. Inspect and stop its owned work; this journal cannot resume collection.')
  if (preparationLedger?.open) {
    invariant(recover, 'Qualification preparation was interrupted. Inspect its owned work and explicitly recover its accounting; collection cannot resume automatically.')
    const row = preparationLedger.rows.find(row => row.status === 'open')
    try { await write({ type: 'qualification-failed', at: new Date(now()).toISOString(), preparationSeq: row.startSeq, status: 'interrupted',
      elapsedMs: null, budgetChargeMs: row.reservedMs, reason: 'Recovered accounting for an orphan preparation. Its full timeout and settlement allowance are reserved; elapsed time and interpreter termination are unknown. This journal remains halted.' }) }
    catch (error) { error.keepLock = true; error.qualificationUnsettled = true; throw error }
    throw unresolvedPreparation('Recovered interrupted qualification accounting. Interpreter termination remains unconfirmed; this journal cannot resume collection.')
  }
  const resourceLedger = resourcePreparationLedger(project, events)
  if (resourceLedger?.open) {
    invariant(recover, 'Resource preparation was interrupted. Explicitly recover its reserved accounting before fresh conformance or collection.')
    const row = resourceLedger.rows.find(row => row.status === 'open')
    await write({ type: 'template-preparation-failed', at: new Date(now()).toISOString(), preparationSeq: row.startSeq,
      status: 'interrupted', elapsedMs: null, budgetChargeMs: row.reservedMs,
      reason: 'Recovered an orphan bounded-map preparation. Its full deadline is charged; elapsed time is unknown. No child process or external effect belongs to this preparation. Fresh conformance remains required before collection.' })
  }
  const observationEnabled = !!project.spec.observationPlan, measuredClock = selectedGate || resourceStudy(project), clock = observationEnabled || measuredClock ? monotonic : now
  for (const start of unfinished) {
    const trial = project.schedule.find(trial => trial.id === start.trialId), workflow = newWorkflowState(project, trial, start.attempt)
    if (workflow) for (const event of events.filter(event => event.trialId === start.trialId && event.attempt === start.attempt && event.type.startsWith('workflow-'))) acceptWorkflowEvent(workflow, event)
    const row = { type: 'finished', trialId: start.trialId, attempt: start.attempt, status: 'interrupted', elapsedMs: null, budgetChargeMs: project.spec.protocol.timeoutMs, reason: 'Recovered an interrupted attempt; no response or duration was inferred. Its full timeout is reserved against the time budget.' }
    if (workflow) { row.workflow = workflowEvidence(workflow); row.phase = 'workflow' }
    if (observationEnabled) row.observations = attemptObservations(project, project.schedule.find(trial => trial.id === start.trialId), row)
    await write(row)
    if (workflow || resourceStudy(project)) return { events, summary: analyze(project, events) }
  }
  const startedAt = clock(), protocol = project.spec.protocol
  const executionPurpose = project.spec.executionPlan?.purpose || 'legacy'
  const admit = () => {
    // A modern study must pin the COMPLETE runtime for ITS OWN schema version,
    // not for whatever this build happens to ship. Comparing against the current
    // RUNTIME_FILES made every schema-2 project unrunnable the moment a compiler
    // module was added; comparing against the version's own inventory keeps the
    // real property -- a study never runs against modules it did not pin -- while
    // letting the runtime grow under a new schema version.
    if (modernSchema(project)) {
      const pinned = runtimeFilesForVersion(project.version)
      invariant(pinned.every(file => project.spec.runtimeSources?.[file]) && canonical(project.runtimeFiles) === canonical(pinned),
        `Pin the complete schema-${project.version} runtime (${pinned.length} files) for version ${project.version} execution.`)
    }
    return assertCollectionAdmission(project, { operation: executionPurpose === 'experiment' ? 'collect' : executionPurpose === 'apparatus-development' ? 'apparatus-development' : 'diagnostic-replay', canonicalReplay: adapter === replayAdapter })
  }
  let qualifiedThisRun = false, templateQualifiedThisRun = false
  const priorDuration = events.filter(row => row.type === 'finished' || templatePreparation(row) || ['qualification', 'qualification-failed'].includes(row.type)).reduce((sum, row) => sum + (row.budgetChargeMs ?? row.elapsedMs ?? 0), 0)
  const timeUsed = () => priorDuration + clock() - startedAt
  for (const trial of project.schedule) {
    if (signal.aborted || timeUsed() >= protocol.maxDurationMs) break
    const prior = history.get(trial.id) || []
    if (prior.some(row => row.type === 'finished' && row.status === 'completed')) continue
    const usedAttempts = prior.filter(row => row.type === 'started').length
    if (usedAttempts < protocol.maxAttemptsPerTrial && totalStarts < protocol.maxTotalAttempts) admit()
    if (usedAttempts < protocol.maxAttemptsPerTrial && totalStarts < protocol.maxTotalAttempts && resourceStudy(project) && !templateQualifiedThisRun) {
      signal.throwIfAborted()
      invariant([...LEGACY_RUNTIME_FILES, ...runtimeFilesFor(project)].every(file => project.spec.runtimeSources?.[file]), 'Pin the complete generated runtime before qualifying or running a resource experiment.')
      invariant(resourcePreparationLedger(project, events).preparations < project.schedule.length + 1, 'The resource experiment reached its frozen preparation-count limit; further preparation requires a new design.')
      const packets = project.tasks.map(task => task.resource), preparationStart = clock()
      const timeoutMs = Math.min(RESOURCE_PREPARATION_LIMITS.timeoutMs, Math.max(0, protocol.maxDurationMs - timeUsed()))
      if (timeoutMs <= 0) break
      const intent = await write({ type: 'template-preparation-started', at: new Date(now()).toISOString(), timeoutMs, reservedMs: timeoutMs })
      const controller = new AbortController()
      const cancel = () => controller.abort(signal.reason || new Error('Template preparation cancelled.'))
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
      let record, failure, timedOut = false
      const deadline = () => { timedOut = true; controller.abort(new Error('Template preparation exceeded its source-bound deadline or remaining study time budget.')) }
      const remaining = Math.min(timeoutMs - (clock() - preparationStart), protocol.maxDurationMs - timeUsed())
      const timer = setTimeout(deadline, Math.max(1, remaining))
      if (remaining <= 0) deadline()
      try {
        controller.signal.throwIfAborted()
        // This finite in-memory interpreter is awaited through cancellation;
        // it owns no child process and cannot leave late journal writes.
        record = await resourceConformance(project.spec.runtimeSources, packets, { signal: controller.signal })
        await verifyResourceConformance(record, project.spec.runtimeSources, packets)
        if (clock() - preparationStart > timeoutMs || timeUsed() >= protocol.maxDurationMs) deadline()
        controller.signal.throwIfAborted()
        const previous = events.find(event => event.type === 'template-qualified')?.record
        invariant(!previous || canonical(previous) === canonical(record), 'Fresh template qualification differs from the retained source and case proof.')
      } catch (error) { failure = String(error.message || error).slice(0, 4096) }
      finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
      const elapsedMs = Math.max(0, clock() - preparationStart)
      const preparation = { at: new Date(now()).toISOString(), preparationSeq: intent.seq, elapsedMs, budgetChargeMs: elapsedMs }
      try {
        if (failure) await write({ type: 'template-preparation-failed', ...preparation,
          status: timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'failed', reason: failure })
        else {
          const previous = events.find(event => event.type === 'template-qualified')
          await write(previous ? { type: 'template-requalified', ...preparation, recordSha256: record.sha256 } : { type: 'template-qualified', ...preparation, record })
        }
      } catch (error) {
        // The durable intent preserves recoverable accounting if the terminal
        // append fails. The joined map has no unresolved external ownership.
        error.events = structuredClone(events); error.summary = analyze(project, events); throw error
      }
      if (failure) return { events, summary: analyze(project, events), preparationFailure: failure }
      templateQualifiedThisRun = true
    }
    if (usedAttempts < protocol.maxAttemptsPerTrial && totalStarts < protocol.maxTotalAttempts && selectedInputGate(project) && !qualifiedThisRun) {
      invariant(typeof qualify === 'function', 'Selected-input qualification is required. Use the exported CLI or research run service with independent interpreters.')
      invariant(!preparationLedger.missingCharge, 'Legacy qualification has unavailable preparation time charges. Read-only analysis remains available; further collection needs an inspected new design with cumulative accounting.')
      invariant(events.filter(event => event.type === 'qualification-started').length < protocol.maxTotalAttempts + 1, 'The selected-input preparation-count limit is exhausted.')
      const preparationStart = clock(), timeoutMs = Math.min(selectedGate.timeoutMs, Math.max(0, protocol.maxDurationMs - timeUsed()))
      if (timeoutMs <= 0) break
      const intent = await write({ type: 'qualification-started', at: new Date(now()).toISOString(), timeoutMs,
        settlementMs: SELECTED_INPUT_PREPARATION_LIMITS.settlementMs, reservedMs: timeoutMs + SELECTED_INPUT_PREPARATION_LIMITS.settlementMs })
      const controller = new AbortController(), abort = () => controller.abort(signal.reason || new Error('Qualification cancelled.'))
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      let timer, abortListener, timedOut = false, settled = false, outcome, record, failure, diagnostic
      const deadline = () => {
        if (controller.signal.aborted) return
        timedOut = true; controller.abort(new Error('Selected-input qualification exceeded its frozen time budget.'))
      }
      // The durable intent consumes preparation and study time before the
      // qualifier is admitted. Check both remaining budgets synchronously.
      const remaining = Math.min(timeoutMs - (clock() - preparationStart), protocol.maxDurationMs - timeUsed())
      const pending = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return qualify(project, { signal: controller.signal, preparationSeq: intent.seq }) })
      const joined = pending.then(value => { settled = true; return outcome = { value } }, error => { settled = true; return outcome = { error } })
      const stopped = new Promise((resolve, reject) => {
        abortListener = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abortListener, { once: true })
        if (controller.signal.aborted) abortListener()
        timer = setTimeout(deadline, Math.max(1, remaining))
        if (remaining <= 0) deadline()
      })
      try {
        const result = await Promise.race([joined, stopped])
        if (result.error) throw result.error
        record = immutable(structuredClone(result.value))
        controller.signal.throwIfAborted(); await verifySelectedInputQualification(project, record); controller.signal.throwIfAborted()
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)) }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', abortListener) }
      if (!settled) {
        let joinTimer
        try { await Promise.race([joined, new Promise(resolve => { joinTimer = setTimeout(resolve, SELECTED_INPUT_PREPARATION_LIMITS.settlementMs) })]) }
        finally { clearTimeout(joinTimer) }
        if (!settled) throw unresolvedPreparation('Qualification did not settle within its cleanup allowance. Its durable intent and lock remain; interpreter termination is unconfirmed.')
      }
      if (!failure && outcome?.error) failure = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
      else if (failure && outcome?.error && outcome.error !== failure) {
        // Cancellation can win before the joined qualifier finishes retaining
        // its process/partial proof. Keep those actual diagnostics on the
        // returned error; the bounded journal disposition remains cancellation.
        failure.settledQualificationError = outcome.error
        for (const key of ['evidence', 'partialQualification']) if (outcome.error[key] !== undefined && failure[key] === undefined) failure[key] = outcome.error[key]
      }
      const elapsedMs = Math.max(0, clock() - preparationStart), terminal = { at: new Date(now()).toISOString(), preparationSeq: intent.seq, elapsedMs, budgetChargeMs: elapsedMs }
      if (!failure) {
        const event = { type: 'qualification', ...terminal, record, projectSha256: project.sha256, seq: events.length + 1 }, encoded = canonical(event), bytes = utf8Bytes(encoded)
        if (bytes > SELECTED_INPUT_PREPARATION_LIMITS.proofBytes || journalBytes + bytes + 1 > journalLimit
          || serializedEventBytes + eventEvidenceBytes(event) > SELECTED_INPUT_PREPARATION_LIMITS.eventEvidenceBytes) {
          diagnostic = { bytes, sha256: await sha256(encoded), reason: 'qualification-evidence-byte-limit' }
          failure = new Error('The full qualification proof exceeds the remaining evidence byte budget. Its raw CLI preflight proof is retained; no candidate was dispatched.')
        }
      }
      try {
        if (failure) await write({ type: 'qualification-failed', ...terminal, status: timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'failed',
          reason: String(failure.message || failure).slice(0, 4096), ...(diagnostic ? { diagnostic } : {}) })
        else { await write({ type: 'qualification', ...terminal, record }); qualifiedThisRun = true }
      } catch (error) { error.keepLock = true; error.events = structuredClone(events); throw error }
      if (failure) {
        if (record !== undefined) failure.rejectedQualification = record
        failure.events = structuredClone(events); failure.summary = analyze(project, events); throw failure
      }
    }
    const task = project.tasks.find(row => row.id === trial.taskId)
    const condition = project.spec.conditions.find(row => row.id === trial.conditionId)
    for (let attempt = usedAttempts + 1; attempt <= protocol.maxAttemptsPerTrial; attempt++) {
      if (signal.aborted || timeUsed() >= protocol.maxDurationMs || totalStarts >= protocol.maxTotalAttempts) break
      admit()
      const start = now(), attemptStart = measuredClock ? clock() : start, meter = observationEnabled ? createObservationMeter(monotonic) : null
      // The envelope is built once, here, and that same object is handed to the adapter and
      // retained, so the report can show what was sent instead of rebuilding it afterwards.
      // A replay condition sends nothing anywhere and a workflow retains its own per-stage
      // requests, so neither carries one.
      const workflow = newWorkflowState(project, trial, attempt)
      const dispatched = (workflow || condition.adapter.kind === 'replay') ? null : collectionRequest(project, condition, task, trial, attempt)
      await write({ type: 'started', trialId: trial.id, attempt, at: new Date(start).toISOString(), promptSha256: task.compiled.promptSha256,
        ...(dispatched ? { request: dispatched } : {}),
        ...(modernSchema(project) ? { readinessSha256: project.readiness.sha256, executionPurpose } : {}), ...(runtime ? { runtime } : {}) })
      const controller = new AbortController()
      const stop = () => controller.abort(signal.reason || new Error('Run cancelled.'))
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
      const timer = setTimeout(() => controller.abort(new Error('Attempt time budget exceeded.')), Math.min(protocol.timeoutMs, Math.max(1, protocol.maxDurationMs - timeUsed())))
      let result, responseEvidence, lateEvidence, gradingEvidence, pending, grading, containmentUnknown = false, phase = workflow ? 'workflow' : 'transport'
      try {
        controller.signal.throwIfAborted()
        const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
        if (workflow) aborted.catch(() => {})
        pending = Promise.resolve().then(() => measuredPhase(meter, 'collection', measure => workflow
          ? executeWorkflow(workflow, { adapter, write, signal: controller.signal, settle: () => measuredPhase(meter, 'settlement', settle), measure, truncate: () => meter?.truncateOpen(), isCancelled: () => signal.aborted, now, monotonic })
          : adapter({ project, condition, task, trial, attempt, ...(dispatched ? { request: dispatched } : {}), signal: controller.signal, ...(measure ? { measure } : {}) })))
        pending.then(value => { if (controller.signal.aborted) lateEvidence = value }, error => { if (error?.evidence) lateEvidence = error.evidence })
        // The workflow joins its bounded stage cancellation and durable terminal
        // record before its parent ends; it must never write late stage events.
        const response = workflow ? await pending : await Promise.race([pending, aborted])
        controller.signal.throwIfAborted() // A late response cannot become a score.
        if (observationEnabled || resourceStudy(project)) phase = 'extraction'
        const raw = await measuredPhase(meter, 'response-extraction', async () => {
          if (resourceStudy(project) && response !== undefined) {
            const text = canonical(response), encoded = new TextEncoder().encode(text), limit = project.experimentTemplate.limits.maxResponseBytes
            if (encoded.length > limit) {
              responseEvidence = { rejectedResponse: { complete: false, reason: 'response-byte-limit', limit, bytes: encoded.length,
                sha256: await sha256(text), diagnosticPrefix: new TextDecoder().decode(encoded.subarray(0, 4096)) } }
              throw new Error('The response exceeds the generated experiment bound. Its size, hash and diagnostic prefix are retained; no action was executed.')
            }
          }
          if (response !== undefined) responseEvidence = JSON.parse(canonical(response))
          invariant(response && Object.hasOwn(response, 'output'), 'The adapter returned no output.')
          return immutable(responseEvidence)
        })
        responseEvidence = raw
        phase = 'grading'
        await measuredPhase(meter, 'response-persistence', () => recordResponse(Object.freeze({ projectSha256: project.sha256, trialId: trial.id, attempt, response: raw })))
        controller.signal.throwIfAborted()
        if (observationEnabled) {
          phase = 'observation'
          const observed = observeResponse(project.spec, condition, raw)
          invariant(observed.eligible, `The response does not meet the frozen observation policy: ${observed.ineligibility.join(', ')}. The response is retained; it cannot be redrawn.`)
        }
        phase = 'grading'
        grading = Promise.resolve().then(() => measuredPhase(meter, 'grading', async measure => resourceStudy(project)
          ? (await executeResourcePlan(task.resource, raw.output, { binding: { projectSha256: project.sha256, trialId: trial.id, attempt }, write, signal: controller.signal })).grade
          : (['exact', 'json', 'judge-audit'].includes(protocol.grading.kind) ? gradeResponse : grade)(project, task, raw.output, { signal: controller.signal, trial, attempt, ...(measure ? { measure } : {}) })))
        grading.catch(error => { if (error?.evidence) gradingEvidence = error.evidence; if (error?.terminationConfirmed === false) containmentUnknown = true })
        // Owned resource execution joins its durable observations and disposal
        // before ending the attempt; it cannot write effects after cancellation.
        const scored = resourceStudy(project) ? await grading : await Promise.race([grading, aborted])
        controller.signal.throwIfAborted()
        if (project.spec.protocol.grading.kind === 'module') {
          try { recordedCustomGrade({ grade: scored, trialId: trial.id }) }
          catch (error) {
            // Retain rejected JSON results when representable. Non-JSON caller
            // values cannot be preserved as scientific JSON observations.
            try { gradingEvidence = { output: JSON.parse(canonical(scored)) } } catch {}
            throw error
          }
        }
        invariant(validGrade(task, scored), 'The grader must return a valid score, or explicit nulls for a frozen unresolved audit reference.')
        result = { status: 'completed', response: raw, grade: JSON.parse(canonical(scored)) }
      } catch (error) {
        if (error?.keepLock) throw error
        if (observationEnabled && phase === 'transport' && error?.code === 'RESPONSE_EXTRACTION') phase = 'extraction'
        result = { status: signal.aborted ? 'cancelled' : 'failed', phase, reason: error?.message || String(error), ...(error?.evidence || responseEvidence ? { response: responseEvidence || error.evidence } : {}) }
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', stop)
        // Native adapters certify their owned work has stopped before we join
        // its final response/error evidence. Uncooperative browser adapters
        // cannot delay cancellation merely by leaving a Promise unresolved.
        if (controller.signal.aborted) meter?.truncateOpen()
        await measuredPhase(meter, 'settlement', async () => { if (await settle() === true) await Promise.allSettled([pending, grading].filter(Boolean)) })
      }
      if (result.status !== 'completed' && lateEvidence && !result.response) result.response = JSON.parse(canonical(lateEvidence))
      if (result.status !== 'completed' && gradingEvidence) result.gradingEvidence = JSON.parse(canonical(gradingEvidence))
      const timings = meter?.finish(result.status), elapsedMs = timings ? timings.spans[0].endUs / 1000 : Math.max(0, (measuredClock ? clock() : now()) - attemptStart)
      const end = { type: 'finished', trialId: trial.id, attempt, ...result, elapsedMs, ...(workflow ? { workflow: workflowEvidence(workflow) } : {}) }
      if (observationEnabled) end.observations = attemptObservations(project, trial, end, timings)
      await write(end)
      if (resourceStudy(project)) { validateJournal(project, events); await verifyResourceJournal(project, events) }
      if (containmentUnknown) throw Object.assign(new Error('An owned execution could not be confirmed stopped; inspect the retained resource record before recovery.'), { keepLock: true })
      if (workflow && result.status !== 'completed' || result.status === 'failed' && ['grading', 'extraction', 'observation'].includes(result.phase)) return { events, summary: analyze(project, events) }
      if (resourceStudy(project) && result.status !== 'completed') return { events, summary: analyze(project, events) }
      if (result.status === 'completed' || result.status === 'cancelled') break
    }
  }
  return { events, summary: analyze(project, events) }
}
