// Explicit finite interpretation sets. Agreement within this declared set is
// never promoted to uniqueness of natural-language meaning.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { modernSchema } from './study-schema.mjs'

export const INFORMATION_VERSION = 1
// The authored reading recipe remains version 1. New schema-2 packets also
// review the declared collection context; legacy packets retain their bytes.
export const INFORMATION_PACKET_VERSION = 2
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
export function informationPlanFromTask(task) {
  return { version: INFORMATION_VERSION, scope: 'declared-set', responseMode: 'raw', withheldPaths: [],
    rationale: 'Draft information treatment. Declare the withheld requirements and defensible readings before collection.',
    readingPool: [{ id: 'baseline', root: structuredClone(task.root), ...(task.variables ? { variables: structuredClone(task.variables) } : {}),
      expected: structuredClone(task.expected), rationale: 'Draft baseline from the selected task; review and extend this candidate pool.' }] }
}
export function validateInformation(information) {
  invariant(object(information) && information.version === INFORMATION_VERSION, 'Information treatments need version 1.')
  invariant(information.scope === 'declared-set', 'Interpretation coverage must be labeled declared-set; finite agreement does not establish exhaustive or unique semantics.')
  invariant(typeof information.rationale === 'string' && information.rationale.trim(), 'Explain the withheld information and admissible readings.')
  invariant(['raw', 'tagged-json'].includes(information.responseMode), 'Declare raw or tagged-json responses for the information treatment.')
  invariant(Array.isArray(information.withheldPaths) && information.withheldPaths.every(path => typeof path === 'string' && /^root(?:\/[a-z][a-z0-9_-]{0,63})*$/.test(path)), 'Withheld paths must identify compiled atom occurrences.')
  invariant(new Set(information.withheldPaths).size === information.withheldPaths.length, 'Withheld paths must be distinct.')
  invariant(Object.keys(information).every(key => ['version', 'scope', 'rationale', 'responseMode', 'withheldPaths', 'readings', 'readingPool'].includes(key)), 'The information treatment contains an unsupported field.')
  invariant(Object.hasOwn(information, 'readings') !== Object.hasOwn(information, 'readingPool'), 'Declare explicit readings or a pool filtered by visible prompt consistency, but not both.')
  const readings = information.readings || information.readingPool
  invariant(Array.isArray(readings) && readings.length > 0 && readings.length <= 64, 'Declare 1–64 admissible readings or reading-pool candidates.')
  const seen = new Set()
  for (const reading of readings) {
    invariant(object(reading) && id(reading.id) && !seen.has(reading.id), 'Every reading needs a distinct identifier.')
    invariant(object(reading.root) && typeof reading.rationale === 'string' && reading.rationale.trim(), `${reading.id}: supply a semantic root and rationale.`)
    invariant(reading.label === undefined || typeof reading.label === 'string', `${reading.id}: the reading label must be text.`)
    invariant(reading.variables === undefined || object(reading.variables), `${reading.id}: reading variables must be a named object.`)
    invariant(Object.keys(reading).every(key => ['id', 'label', 'root', 'variables', 'expected', 'rationale', 'conventions'].includes(key)), `${reading.id}: readings cannot change task input or hide additional fields.`)
    if (reading.conventions !== undefined) invariant(object(reading.conventions) && Object.entries(reading.conventions).every(([key, value]) => id(key) && ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))), `${reading.id}: convention assignments must be named finite scalar values.`)
    seen.add(reading.id)
  }
  return information
}
export async function createTaskReviewRecord(task, reviewer, at = new Date().toISOString()) {
  invariant(task.informationPacket?.sha256, 'Prepare the exact information review packet first.')
  invariant(typeof reviewer === 'string' && reviewer.trim() && Number.isFinite(Date.parse(at)), 'A task review needs the reviewer name and a valid timestamp.')
  return { taskId: task.id, reviewer: reviewer.trim(), at, decision: 'approved', packetSha256: task.informationPacket.sha256 }
}
export function taskReviewStatus(task, records = []) {
  invariant(Array.isArray(records) && records.every(object), 'Task review records must be an array of records.')
  const review = records.filter(record => record.taskId === task.id).at(-1)
  return { approved: review?.decision === 'approved' && typeof review.reviewer === 'string' && !!review.reviewer.trim() && Number.isFinite(Date.parse(review.at)) && review.packetSha256 === task.informationPacket?.sha256, review }
}
export async function bindInformationPacket(task, spec, readings) {
  const roots = compiled => compiled.bundles.map(({ id, hash, rootSha256 }) => ({ id, hash, rootSha256 }))
  const packet = { format: 'benchmark-information', version: modernSchema(spec) ? INFORMATION_PACKET_VERSION : INFORMATION_VERSION, taskId: task.id, familyId: task.familyId || null, split: task.split,
    input: task.input ?? null, prompt: task.compiled.text, promptSha256: task.compiled.promptSha256,
    withheldPaths: [...task.information.withheldPaths].sort(), scope: task.information.scope, responseMode: task.information.responseMode, rationale: task.information.rationale,
    recipe: task.information, selection: task.informationSelection,
    grading: spec.protocol.grading, environment: spec.environment || {},
    ...(spec.observationPlan ? { observationPlan: spec.observationPlan, observationConditions: spec.conditions.map(condition => ({ id: condition.id, model: condition.model || null, collection: condition.collection || null, adapterKind: condition.adapter.kind })) } : {}),
    ...(modernSchema(spec) ? { collectionContext: structuredClone({ version: 1, ordinaryCollectionIncluded: !!spec.observationPlan,
      conditions: spec.conditions.map(condition => ({ id: condition.id, model: condition.model || null, collection: condition.collection || null,
        adapterKind: condition.adapter.kind, workflowId: condition.workflowId || null })),
      workflowPlan: spec.workflowPlan || null }) } : {}),
    baseline: { semantic: task.compiled.semantic, expected: task.expected, roots: roots(task.compiled) },
    readings: readings.map(reading => ({ id: reading.id, label: reading.label || reading.id, rationale: reading.rationale,
      semantic: reading.compiled.semantic, expected: reading.expected, conventions: reading.conventions || {}, roots: roots(reading.compiled) })),
    runtimeSources: spec.runtimeSources || {} }
  const classes = new Map()
  for (const reading of readings) {
    const key = canonical(reading.expected)
    if (!classes.has(key)) classes.set(key, { observableSha256: await sha256(key), readings: [] })
    classes.get(key).readings.push(reading.id)
  }
  packet.observableClasses = [...classes.values()]
  return { ...packet, sha256: await sha256(canonical(packet)) }
}
export function decodeInformationResponse(task, output) {
  if (task.information?.responseMode !== 'tagged-json') return { behavior: 'answer', answer: output }
  let value
  try { value = typeof output === 'string' ? JSON.parse(output) : output } catch { return { behavior: 'malformed-response', reason: 'The declared response envelope is not JSON.' } }
  if (!object(value) || !['answer', 'clarification', 'refusal'].includes(value.kind)) return { behavior: 'malformed-response', reason: 'The response needs an answer, clarification, or refusal kind.' }
  if (value.kind === 'answer') {
    if (!Object.hasOwn(value, 'answer') || Object.keys(value).some(key => !['kind', 'answer'].includes(key))) return { behavior: 'malformed-response', reason: 'Answer envelopes contain only kind and answer.' }
    return { behavior: 'answer', answer: value.answer }
  }
  if (typeof value.message !== 'string' || !value.message.trim() || Object.keys(value).some(key => !['kind', 'message'].includes(key))) return { behavior: 'malformed-response', reason: 'Clarification and refusal envelopes need only kind and a nonempty message.' }
  return { behavior: value.kind, message: value.message }
}
export function informationDisposition(decoded) {
  return { passed: false, score: 0, classification: decoded.behavior, behavior: decoded.behavior, matchingReadings: [], interpretationScope: 'declared-set', ...(decoded.reason ? { reason: decoded.reason } : {}) }
}
export function gradeInterpretations(task, output, format) {
  invariant(['json', 'exact'].includes(format), 'Interpretation comparison requires exact text or normalized JSON observations.')
  invariant(Array.isArray(task.interpretations) && task.interpretations.length, 'The task has no frozen interpretation set.')
  let value = output
  // A tagged envelope already contains a decoded JSON value. Parsing its
  // string answer a second time would change "2" into 2 or reject valid text.
  if (format === 'json' && task.information.responseMode !== 'tagged-json' && typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return informationDisposition({ behavior: 'malformed-response', reason: 'The answer is not valid JSON.' }) }
  }
  const matchingReadings = task.interpretations.filter(reading => format === 'exact' ? typeof value === 'string' && value === reading.expected : canonical(value) === canonical(reading.expected)).map(reading => reading.id)
  return { passed: matchingReadings.length > 0, score: matchingReadings.length ? 1 : 0, classification: matchingReadings.length ? 'admissible' : 'outside-declared-set',
    behavior: 'answer', matchingReadings, interpretationScope: 'declared-set' }
}
