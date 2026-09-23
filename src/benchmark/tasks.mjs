// The one task compiler used by previews, freezing, interpretation packets and
// exported verification. The private oracle never enters adapter requests.
import { canonical, compilePrompt, invariant, sha256 } from './prompts.mjs'
import { modernSchema } from './study-schema.mjs'
import { gradingKind } from './registry.mjs'
import { interpretLean, validateLean } from './lean.mjs'
import { bindInformationPacket, taskReviewStatus, validateInformation } from './information.mjs'
import { renderComposition, compositionRequirements } from './composition.mjs'
import { lowerTradingIR } from './trading-ir.mjs'
import { validateTradingMarket, simulateTradingMarket } from './trading-market.mjs'
import { operationalStudy, operationalPromptContract, operationalBrokerChronology, leanContractId } from './trading-study.mjs'
import { tradingObservationContract } from './trading-observations.mjs'

export async function deriveTaskExpected(spec, task) {
  const compiled = await compilePrompt(spec.catalog, task.root, { variables: task.variables || {} })
  return operationalStudy(spec) ? simulateTradingMarket(await lowerTradingIR(compiled.composition, task.input?.execution), task.input).observation
    : interpretLean(compiled.semantic, task.input).trace
}

export function taskGradingContract(spec) {
  const grading = { ...spec.protocol.grading }
  if (grading.kind === 'lean-python') grading.executionTimeoutMs ??= Math.min(60000, spec.protocol.timeoutMs - 1000)
  return grading
}

export async function semanticTaskId(domain, task) {
  const variance = task.compiled.composition?.omissions || task.compiled.composition?.nodes.some(node => node.omissions?.length)
  return sha256(canonical(task.information
    ? { promptSha256: task.compiled.promptSha256, input: task.input ?? null,
        readings: task.interpretations.map(reading => canonical({ semantic: reading.compiled.semantic, expected: reading.expected })).sort() }
    : { semantic: task.compiled.semantic, input: task.input ?? null, ...(domain === 'generic' || variance ? { promptSha256: task.compiled.promptSha256 } : {}), ...(task.resource ? { resourcePacketSha256: task.resource.sha256 } : {}) }))
}

function appendContract(compiled, text, spec, id) {
  compiled.composition.appendices.push(JSON.parse(canonical({ id, text, source: 'tasks.mjs', sha256: spec.runtimeSources?.['tasks.mjs'] || null })))
  Object.assign(compiled, renderComposition(compiled.composition), { checklist: compositionRequirements(compiled.composition) })
}
function semanticAnswerContract(task, { operational = false } = {}) {
  const output = task.information?.responseMode === 'tagged-json' ? 'Place the complete JSON observation in the answer field of the response envelope specified below.' : 'Return only the complete JSON observation value, without a code fence or explanatory text.'
  return '\n\nSemantic answer contract (part of this exact prompt):\n' + output
    + ' Compute the deterministic observation under the frozen semantic rules and supplied inputs. This task evaluates a semantic answer; it does not execute a submitted program or establish a native engine result. Preserve array ordering and every required field. Use integer cents for money and the exact ownership paths from the prompt. Do not infer liquidation at the end of the input.\n'
    + (operational ? 'Return an object with format="lean-operational-observation", version=1, orders, events, lots, cashFromFillsCents, positionsFromFills, feesCents and equityCents. Orders are in creation order and contain order (1-based), owner, lot (1-based within owner), asset, time (UTC Unix seconds), quantity (signed), reason, status, filledQuantity (absolute), feesCents, unfilledQuantity and pending. Events are in observation order and contain order, time, status, quantity (signed), priceCents and feeCents; non-fill events have zero quantity, price and fee. Lots are in first-entry order and contain owner, lot, asset, boughtQuantity, soldQuantity, quantity (remaining), firstFillTime and lastFillTime (null before any fill). positionsFromFills follows the declared asset order and contains {asset,quantity}; equityCents contains {start,end}. Order and lot identifiers normalize creation/first-entry order from 1. Reasons are entry, exit, reset, gate-close or race-release. Status strings are new, accepted, partial, filled, cancelled, rejected, cancel-pending or none; use the actual state reached under the frozen rules. Reasons, status transitions, delayed capped fills, cancellation settlement and private lot ownership follow the operational constitution and frozen market rules. '
      : 'Return the ordered JSON fill array. Each entry contains exactly bar (zero-based completed-input index), path (exact strategy ownership path), symbol, signed quantity, priceCents and reason (buy, sell or reset), in the declared interpreter event order. An empty trace is []. ')
}
async function compileOne(spec, task, { requireReview, withheldPaths = [], generatedExpected = false, validateExpected = true } = {}) {
  const compiled = await compilePrompt(spec.catalog, task.root, { requireReview, variables: task.variables || {}, reviews: spec.reviews || [], withheldPaths, omissions: task.promptOmissions })
  if (task.variance) invariant(task.variance.sourceSha256 === (task.promptOmissions?.sourceSha256 || compiled.promptSha256), `${task.id}: the variance provenance differs from the original prompt fingerprint.`)
  let expected = task.expected
  if (operationalStudy(spec)) {
    invariant(compiled.bundles.some(bundle => bundle.id === leanContractId(spec)), `${task.id}: bind the operational contract as a reviewed bundle dependency.`)
    const ir = await lowerTradingIR(compiled.composition, task.input?.execution)
    validateTradingMarket(ir, task.input)
    if (modernSchema(spec) && spec.protocol.grading.kind === 'json') {
      const constitution = spec.catalog.find(bundle => bundle.id === leanContractId(spec))
      invariant(constitution?.kind === 'atom' && constitution.role === 'contract' && typeof constitution.text === 'string' && !constitution.text.includes('{{'), 'Operational studies need the explicit literal operational-contract-v1 review bundle.')
      appendContract(compiled, semanticAnswerContract(task, { operational: true })
        + '\nOperational constitution: ' + constitution.text
        + '\nPublic broker chronology: ' + operationalBrokerChronology
        + '\nExecution and lifecycle policy: ' + canonical(task.input.execution)
        + '\nPublic observation and market inputs: ' + canonical(tradingObservationContract(ir, task.input)), spec, 'operational-semantic-answer-contract')
    } else {
      const outputInstruction = task.information?.responseMode === 'tagged-json' ? 'Place the Python source in the answer field of the response envelope specified below.' : 'Return only Python source or one fenced python block.'
      appendContract(compiled, operationalPromptContract(spec, ir, task.input, outputInstruction), spec, 'operational-execution-contract')
    }
  } else if (spec.domain === 'lean-bench') {
    invariant(compiled.semantic.kind === 'constitution', `${task.id}: wrap the strategy in the reviewed semantic constitution.`)
    validateLean(compiled.semantic, task.input)
    const interpreted = interpretLean(compiled.semantic, task.input)
    if (generatedExpected && !Object.hasOwn(task, 'expected')) expected = interpreted.trace
    invariant(!validateExpected || canonical(interpreted.trace) === canonical(expected), `${task.id}: the expected trace disagrees with the semantic interpretation. Inspect both before freezing.`)
    const leaves = [], pending = [compiled.semantic]
    while (pending.length) { const node = pending.pop(); if (node.kind === 'strategy') leaves.push({ path: node.path, symbol: node.symbol }); else pending.push(...node.childOrder.map(key => node.children[key]).reverse()) }
    if (modernSchema(spec) && spec.protocol.grading.kind === 'json') appendContract(compiled, semanticAnswerContract(task)
      + '\nStrategy paths: ' + canonical(leaves) + '\nFrozen completed-bar inputs (integer cents): ' + canonical(task.input), spec, 'semantic-answer-contract')
    else {
      const outputInstruction = task.information?.responseMode === 'tagged-json' ? 'Place the Python source in the answer field of the response envelope specified below.' : 'Return only Python source or one fenced python block.'
      appendContract(compiled, '\n\nExecution appendix (part of this exact prompt):\nImplement class FrozenBenchmark(QCAlgorithm). ' + outputInstruction + ' Configure UTC time, the declared dates, cash and RAW minute equity subscriptions; zero fees and slippage. Native order tags must be the exact strategy path followed by |buy, |sell or |reset. Actual filled order events, quantities, times, prices and tags are graded; printed trace claims are ignored. Do not liquidate at end of data.\nStrategy paths: ' + canonical(leaves) + '\nFrozen completed-bar inputs (integer cents): ' + canonical(task.input), spec, 'execution-contract')
    }
  }
  if (task.information?.responseMode === 'tagged-json') appendContract(compiled, '\n\nResponse format (part of this exact prompt):\nReturn one JSON object. For an answer use {"kind":"answer","answer":...}. For a request for missing information use {"kind":"clarification","message":"..."}. For a refusal use {"kind":"refusal","message":"..."}. Do not include any other fields. The answer field contains the requested result or program.', spec, 'response-envelope')
  if (spec.protocol.grading.kind === 'judge-audit') appendContract(compiled, '\n\nJudge response format (part of this exact prompt):\nReturn one JSON object with verdict equal to "accept", "reject", "undetermined", or "abstain". An optional reason field may contain text. Include no other fields.', spec, 'judge-contract')
  if (operationalStudy(spec)) {
    compiled.operational = await lowerTradingIR(compiled.composition, task.input.execution)
    const interpreted = simulateTradingMarket(compiled.operational, task.input).observation
    if (generatedExpected && !Object.hasOwn(task, 'expected')) expected = interpreted
    invariant(!validateExpected || canonical(interpreted) === canonical(expected), `${task.id}: the expected operational observation disagrees with the semantic interpretation. Inspect both before freezing.`)
  }
  invariant(expected !== undefined, `${task.id}: supply the expected result (null is permitted for a custom grader).`)
  if (spec.protocol.grading.kind === 'exact') invariant(typeof expected === 'string', `${task.id}: exact text grading needs a string answer. Use JSON grading for other values.`)
  compiled.promptSha256 = await sha256(compiled.text)
  return { ...task, expected, compiled }
}

export async function compileTask(spec, task, { requireReview = spec.requireReview === true, requireTaskReview = requireReview, validateExpected = true } = {}) {
  spec = { ...spec, protocol: { ...spec.protocol, grading: taskGradingContract(spec) } }
  const information = task.information
  if (information) {
    validateInformation(information)
    invariant(typeof task.familyId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(task.familyId), `${task.id}: information variants need an explicit familyId.`)
    // A literal allowlist with a vertical's own contract inside it ('lean-python'),
    // so a benchmark's own grading contract was refused here however else the
    // core had been opened up. Whether a contract can carry an information
    // treatment belongs to whoever implemented the contract.
    const contract = gradingKind(spec.protocol.grading.kind)
    invariant(['exact', 'json'].includes(spec.protocol.grading.kind) || contract?.supportsInformation === true,
      'Information treatments require exact or JSON grading, or a registered grading contract that declares supportsInformation; an unrelated custom grader cannot silently replace the declared interpretation set.')
  }
  const compiled = await compileOne(spec, task, { requireReview, withheldPaths: information?.withheldPaths || [], validateExpected })
  if (!information) return compiled
  const interpretations = [], identities = new Set(), candidates = []
  for (const reading of information.readings || information.readingPool) {
    const input = { ...task, root: reading.root, variables: { ...(task.variables || {}), ...(reading.variables || {}) } }
    if (Object.hasOwn(reading, 'expected')) input.expected = reading.expected
    else delete input.expected
    const result = await compileOne(spec, input, { requireReview, withheldPaths: information.withheldPaths, generatedExpected: true })
    const consistent = result.compiled.text === compiled.compiled.text
    invariant(consistent || information.readingPool, `${task.id}/${reading.id}: the reading changes disclosed prompt content. Every admissible reading must agree on the exact visible prompt.`)
    candidates.push({ id: reading.id, disposition: consistent ? 'retained' : 'disclosed-conflict', promptSha256: result.compiled.promptSha256,
      semanticSha256: await sha256(canonical(result.compiled.semantic)), roots: result.compiled.bundles.map(({ id, hash, rootSha256 }) => ({ id, hash, rootSha256 })) })
    if (!consistent) continue
    const identity = canonical(result.compiled.semantic)
    invariant(!identities.has(identity), `${task.id}: two declared readings have the same semantic representation.`)
    identities.add(identity)
    interpretations.push({ ...reading, expected: result.expected, compiled: result.compiled })
  }
  compiled.interpretations = interpretations
  invariant(interpretations.length > 0, `${task.id}: no declared reading agrees with the visible prompt.`)
  compiled.informationSelection = { rule: information.readingPool ? 'visible-consistency' : 'explicit-readings', candidates }
  compiled.informationPacket = await bindInformationPacket(compiled, spec, interpretations)
  invariant(!requireTaskReview || taskReviewStatus(compiled, spec.taskReviews || []).approved, `${task.id}: review the current visible prompt and complete admissible-reading packet before freezing.${modernSchema(spec) ? ' Include the declared condition settings, workflow assignments and stage context.' : ''}`)
  return compiled
}
