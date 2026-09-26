// Audits of a judge against a frozen reference criterion. Source observations
// and the judge's later verdict remain separate, version-bound evidence.
import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { modernSchema } from './study-schema.mjs'
import { safePath, verifyProject, freezeStudy, RUNTIME_FILES } from './study.mjs'
import { validateJournal, verifyResourceJournal } from './runner.mjs'
import { decodeInformationResponse, gradeInterpretations, informationDisposition } from './information.mjs'
import { nativeObservation, leanConfig, matchesNativeObservationProfile, leanContainerRecord } from './lean-observations.mjs'
import { extractSource, sourceFailureClassification } from './extraction.mjs'
import { extractionPolicyFor } from './registry.mjs'
import { genericStarter } from './starters.mjs'
import { operationalCandidateFiles, operationalStudy, operationalReferenceProgram } from './trading-study.mjs'
import { generateLeanProgram, inlineLeanProgram } from './lean-codegen.mjs'
import { verifyQualificationJournal, nativeControlSource } from './requirements.mjs'

export const AUDIT_VERSION = 1
export const AUDIT_VERDICTS = ['accept', 'reject', 'undetermined', 'abstain']
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = value => typeof value === 'string' && !!value.trim()
const referenceLimit = encoded => invariant(new TextEncoder().encode(encoded).byteLength <= 64 * 1024 * 1024, 'Reference bundles are limited to 64 MiB of JSON text; split the source study explicitly when a larger archive is needed.')
const fields = (value, allowed, label) => invariant(Object.keys(value).every(key => allowed.includes(key)), `${label} contains an unsupported field.`)
const hasNativeObservation = (project, grade) => matchesNativeObservationProfile(grade.trace, operationalStudy(project.spec))

export function auditFileBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  invariant(object(value) && value.encoding === 'base64' && typeof value.data === 'string' && Object.keys(value).every(key => ['encoding', 'data'].includes(key)), 'Reference bytes need UTF-8 text or an explicit base64 payload.')
  let decoded; try { decoded = atob(value.data) } catch { throw new Error('Reference bytes contain invalid base64.') }
  return Uint8Array.from(decoded, char => char.charCodeAt(0))
}
export function auditFileText(bundle, path) {
  invariant(Object.hasOwn(bundle.files, path), `The reference bundle omits ${path}.`)
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(auditFileBytes(bundle.files[path]))
}

export function auditReferencePaths(project, events) {
  const paths = Object.keys(project.spec.runtimeSources || {}).map(file => ({ key: `runtime/${file}`, location: 'project', path: file }))
  for (const input of project.spec.inputs) paths.push({ key: `inputs/${input.path}`, location: 'project', path: input.path })
  if (project.spec.protocol.grading.kind === 'lean-python') for (const event of events.filter(row => row.type === 'finished' && row.status === 'completed' && row.grade.directory)) {
    const id = `${event.trialId}-${event.attempt}`, prefix = `native/${id}`
    invariant(event.grade.directory === `artifacts/${id}`, 'Native evidence has an unexpected artifact directory.')
    for (const [name, path] of [['main.py', 'algorithm/main.py'], ['config.json', 'config.json'], ['execution.json', 'execution.json']]) paths.push({ key: `${prefix}/${name}`, location: 'results', path: `${event.grade.directory}/${path}` })
    if (operationalStudy(project.spec)) for (const file of ['candidate.py', 'trading_broker.py']) paths.push({ key: `${prefix}/${file}`, location: 'results', path: `${event.grade.directory}/algorithm/${file}` })
    if (hasNativeObservation(project, event.grade)) {
      paths.push({ key: `${prefix}/result.json`, location: 'results', path: `${event.grade.directory}/results/${id}.json` })
      if (event.grade.files?.includes(`${id}-order-events.json`)) paths.push({ key: `${prefix}/order-events.json`, location: 'results', path: `${event.grade.directory}/results/${id}-order-events.json` })
    }
  }
  invariant(paths.every(row => safePath(row.key) && safePath(row.path)), 'Reference evidence paths must stay inside the source project or result directory.')
  return paths
}

export async function sealAuditReference(project, events, files) {
  const payload = { format: 'benchmark-audit-reference', version: AUDIT_VERSION, project: structuredClone(project), events: structuredClone(events), files: structuredClone(files) }
  const encoded = canonical(payload)
  referenceLimit(encoded)
  const bundle = { ...payload, sha256: await sha256(encoded) }
  await verifyAuditReference(bundle)
  return bundle
}
export async function verifyAuditReference(bundle) {
  invariant(object(bundle) && bundle.format === 'benchmark-audit-reference' && bundle.version === AUDIT_VERSION && hash(bundle.sha256), 'Import a version 1 benchmark audit reference bundle.')
  fields(bundle, ['format', 'version', 'project', 'events', 'files', 'sha256'], 'Reference bundle')
  invariant(!bundle.project?.spec?.auditPlan, 'A judge audit cannot recursively serve as its own reference study.')
  invariant(object(bundle.files) && Object.keys(bundle.files).every(safePath), 'Reference files must have safe paths.')
  const { sha256: digest, ...payload } = bundle, encoded = canonical(payload)
  referenceLimit(encoded)
  for (const value of Object.values(bundle.files)) auditFileBytes(value)
  invariant(await sha256(encoded) === digest, 'The reference bundle changed after sealing.')
  await verifyProject(bundle.project)
  await verifyResourceJournal(bundle.project, bundle.events)
  invariant(object(bundle.project.spec.runtimeSources) && ['study.mjs', 'prompts.mjs', 'runner.mjs', 'tasks.mjs'].every(file => hash(bundle.project.spec.runtimeSources[file])), 'Pin the source compiler and runner before making a reference bundle.')
  invariant(validateJournal(bundle.project, bundle.events).length === 0, 'Finish or explicitly recover an open source attempt before sealing its reference evidence.')
  const required = auditReferencePaths(bundle.project, bundle.events)
  invariant(required.length === Object.keys(bundle.files).length && required.every(row => Object.hasOwn(bundle.files, row.key)), 'The reference bundle must include exactly its pinned runtime, input and native evidence files.')
  for (const [file, expected] of Object.entries(bundle.project.spec.runtimeSources || {})) invariant(await sha256(auditFileBytes(bundle.files[`runtime/${file}`])) === expected, `The source runtime changed: ${file}.`)
  for (const input of bundle.project.spec.inputs) invariant(await sha256(auditFileBytes(bundle.files[`inputs/${input.path}`])) === input.sha256, `The source input changed: ${input.path}.`)
  for (const event of bundle.events.filter(row => row.type === 'finished' && row.status === 'completed')) await verifyReferenceObservation(bundle, event)
  return bundle
}

async function verifyReferenceObservation(bundle, event) {
  const project = bundle.project, trial = project.schedule.find(row => row.id === event.trialId), task = project.tasks.find(row => row.id === trial.taskId)
  if (project.spec.protocol.grading.kind !== 'lean-python') return // Exact/JSON grades were recomputed by validateJournal; custom scores retain their stated basis.
  const decoded = task.information ? decodeInformationResponse(task, event.response.output) : { behavior: 'answer', answer: event.response.output }
  if (decoded.behavior !== 'answer') return
  let code
  const prefix = `native/${event.trialId}-${event.attempt}`, files = bundle.files, read = path => auditFileText(bundle, `${prefix}/${path}`)
  // Re-verification is versioned with the archive. The program that ran is the archived artifact, not a
  // re-extraction of the reply by whichever extractor happens to be imported now: a later change to the
  // extractor must not turn valid archived evidence into a verification failure. A retained grade that
  // records no candidate hash recorded no program, and is checked as that instead.
  if (typeof event.grade.candidateSha256 !== 'string') {
    invariant(['no-program', 'format-violation'].includes(event.grade.classification) && event.grade.passed === false, 'A non-program has an inconsistent source execution grade.')
    return
  }
  code = archivedCandidate(operationalStudy(project.spec), read)
  invariant(event.grade.candidateSha256 === await sha256(code), 'The archived native program differs from the retained candidate hash.')
  const programs = operationalStudy(project.spec) ? operationalCandidateFiles(task, code, { 'trading_broker.py': auditFileText(bundle, 'runtime/trading_broker.py') }) : { 'main.py': code + '\n' }
  for (const [file, expected] of Object.entries(programs)) invariant(read(file) === expected, 'The source native program or public harness differs from the frozen candidate environment.')
  invariant(canonical(JSON.parse(read('config.json'))) === canonical(leanConfig(`${event.trialId}-${event.attempt}`)), 'The source native configuration differs from its frozen execution contract.')
  invariant(event.grade.image === project.spec.environment.leanImage, 'The native source grade has a different engine image.')
  invariant(canonical(JSON.parse(read('execution.json'))) === canonical(event.grade.execution), 'The source execution record differs from the retained grade.')
  if (hasNativeObservation(project, event.grade)) {
    const trace = nativeObservation(JSON.parse(read('result.json')), files[`${prefix}/order-events.json`] ? JSON.parse(read('order-events.json')) : null, task)
    invariant(canonical(trace) === canonical(event.grade.trace), 'The source trace disagrees with its retained native artifacts.')
    const expected = task.information ? gradeInterpretations(task, trace, 'json') : { passed: canonical(trace) === canonical(task.expected) }
    invariant(event.grade.passed === expected.passed && event.grade.score === (expected.passed ? 1 : 0), 'The native reference grade disagrees with its frozen observation criterion.')
  } else invariant(!event.grade.passed && ['execution-error', 'execution-timeout', 'invalid-engine-result', 'format-violation'].includes(event.grade.classification), 'A native candidate needs its trace or an explicit execution-failure record.')
}

// This stricter, explicit contract is separate from the version 1 judge-audit
// archive above. A consistent archive does not authenticate an execution host.
export const NATIVE_EVIDENCE_LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 })
const nativeScope = 'Retained artifacts agree with their declared frozen source and observation contract; native execution, preparation and experimental admission are not established.'
const nativeLimitations = [
  'Source hashes bind the declared compiler, observer, harness and inputs. They do not authenticate who produced the artifacts or executed those sources.',
  'The declared image digest is compared with the frozen environment; the image build, mounted market data, host isolation and preparation history are not proven by these artifacts.',
  'Signals, timeouts, unknown process completion and invalid engine results need additional provenance and are outside this verification contract.',
  'Experimental admission and qualification remain separate requirements. This receipt does not satisfy them or approve a scientific claim.',
]
function nativeReceipt(format, project) {
  return { format, version: 1, projectSha256: project.sha256, evidenceStatus: 'retained-artifact-consistency', scope: nativeScope, limitations: [...nativeLimitations] }
}
// Bound serialization as it is built, and capture before the first async hash.
// Reject values that JSON would silently omit or coerce, including sparse arrays.
function captureNative(value) {
  const parts = [], active = new Set(), encoder = new TextEncoder(); let bytes = 0
  const emit = part => {
    invariant(typeof part === 'string' && part.length <= NATIVE_EVIDENCE_LIMITS.totalBytes, 'Native evidence exceeds the 64 MiB canonical envelope limit.')
    bytes += encoder.encode(part).byteLength
    invariant(bytes <= NATIVE_EVIDENCE_LIMITS.totalBytes, 'Native evidence exceeds the 64 MiB canonical envelope limit.')
    parts.push(part)
  }
  const visit = (item, depth) => {
    invariant(depth <= 512, 'Native evidence JSON nesting exceeds the supported limit.')
    if (item === null || ['boolean', 'number', 'string'].includes(typeof item)) {
      invariant(typeof item !== 'number' || Number.isFinite(item), 'Native evidence requires finite JSON values.')
      invariant(typeof item !== 'string' || item.length <= NATIVE_EVIDENCE_LIMITS.totalBytes, 'Native evidence exceeds the 64 MiB canonical envelope limit.')
      emit(JSON.stringify(item)); return
    }
    invariant(item && typeof item === 'object' && (Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item))) && !active.has(item), 'Native evidence requires finite, acyclic plain JSON values.')
    active.add(item)
    if (Array.isArray(item)) {
      invariant(Object.keys(item).length === item.length, 'Native evidence cannot contain sparse or extended JSON arrays.')
      emit('[')
      for (let i = 0; i < item.length; i++) { invariant(Object.hasOwn(item, i), 'Native evidence cannot contain sparse JSON arrays.'); if (i) emit(','); visit(item[i], depth + 1) }
      emit(']')
    } else {
      emit('{'); let first = true
      for (const key of Object.keys(item).sort()) { if (!first) emit(','); first = false; emit(JSON.stringify(key)); emit(':'); visit(item[key], depth + 1) }
      emit('}')
    }
    active.delete(item)
  }
  visit(value, 0)
  return JSON.parse(parts.join(''))
}
function nativeProjectContract(project) {
  invariant(modernSchema(project) && project.version === project.spec?.schemaVersion, 'Strict native evidence verification requires a modern version 2-or-later frozen project; historical audit archives retain their own contract.')
  invariant(project.spec.protocol?.grading?.kind === 'lean-python', 'Native evidence verification requires the frozen lean-python grader.')
  const sources = project.spec.runtimeSources
  invariant(object(sources) && Object.keys(sources).length === RUNTIME_FILES.length && RUNTIME_FILES.every(file => hash(sources[file])), 'Native evidence requires the complete pinned runtime source inventory.')
  invariant(Array.isArray(project.schedule) && Array.isArray(project.tasks) && Array.isArray(project.spec.inputs), 'Native evidence needs a frozen task schedule and inputs.')
}

// Materialize one compact, frozen registry reference into an ordinary runnable
// auxiliary project. No execution, synthetic review, native receipt or admission
// flag is manufactured. Rebuilding from the parent is the verification path.
export async function materializeNativeControl(project, jobId, { runtimeFiles, inputFiles = {} } = {}) {
  const captured = captureNative({ project, jobId, runtimeFiles, inputFiles })
  project = captured.project; jobId = captured.jobId
  runtimeFiles = captured.runtimeFiles; inputFiles = captured.inputFiles
  nativeProjectContract(project)
  await verifyProject(project)
  const plan = project.nativePreparation, job = plan?.jobs.find(row => row.id === jobId)
  invariant(job, 'Select a control from this frozen native preparation plan.')
  invariant(object(runtimeFiles) && Object.keys(runtimeFiles).length === RUNTIME_FILES.length
    && RUNTIME_FILES.every(file => typeof runtimeFiles[file] === 'string'), 'Native controls need exactly the complete pinned runtime text files.')
  for (const file of RUNTIME_FILES) {
    invariant(new TextEncoder().encode(runtimeFiles[file]).byteLength <= NATIVE_EVIDENCE_LIMITS.fileBytes, 'A native control runtime file exceeds the 16 MiB file limit.')
    invariant(await sha256(runtimeFiles[file]) === project.spec.runtimeSources[file], `The native control runtime source changed: ${file}.`)
  }
  invariant(object(inputFiles) && Object.keys(inputFiles).length === project.spec.inputs.length
    && project.spec.inputs.every(input => Object.hasOwn(inputFiles, input.path)), 'Native controls need exactly all pinned parent input files.')
  const bindingPath = 'native-control/binding.json', paths = new Set()
  for (const input of project.spec.inputs) {
    const lower = input.path.toLowerCase()
    invariant(safePath(input.path) && ![...paths, bindingPath].some(path => lower === path || lower.startsWith(path + '/') || path.startsWith(lower + '/')), 'Native control input paths collide with each other or the generated binding.')
    paths.add(input.path.toLowerCase())
    const bytes = auditFileBytes(inputFiles[input.path])
    invariant(bytes.byteLength <= NATIVE_EVIDENCE_LIMITS.fileBytes, 'A native control input exceeds the 16 MiB file limit.')
    invariant(await sha256(bytes) === input.sha256, `The native control input changed: ${input.path}.`)
  }
  const { reference, program } = nativeControlSource(project.requirements, job.source)
  invariant(await sha256(canonical(program)) === job.programTaskSha256 && await sha256(canonical(reference)) === job.referenceTaskSha256, 'The native control source differs from its frozen job.')
  const code = extractSource(operationalStudy(project.spec) ? operationalReferenceProgram(program, runtimeFiles)
    : inlineLeanProgram(generateLeanProgram(program), runtimeFiles), extractionPolicyFor(project.spec))
  const programSha256 = await sha256(code), budget = plan.budgets
  const binding = { format: 'benchmark-native-control-binding', version: 1, parentProjectSha256: project.sha256, nativePlanSha256: plan.sha256,
    requirementsSha256: project.requirements.sha256, jobId, job, programSha256,
    referenceExpected: reference.expected, programExpected: program.expected,
    predicate: job.kind === 'reference' ? 'own-task-native-observation-equals-reference-expectation'
      : 'own-task-native-observation-equals-mutant-expectation-and-differs-from-bound-reference-expectation',
    scope: 'Generated apparatus development only. This child uses the program task and its own public execution contract. A passing child grade alone does not establish mutant discrimination, baseline-harness rejection, independent qualification, native preparation, host provenance or admission of the parent study. The aggregate plan budget is not enforced across independently run child projects.' }
  const task = { id: 'control', root: program.root, variables: program.variables || {}, input: program.input,
    expected: program.expected, split: 'development', cohort: 'qualification' }
  const spec = { schemaVersion: 2, id: 'native-' + (await sha256(canonical(binding))).slice(0, 40), name: 'Native ' + job.kind + ' control for ' + project.spec.name,
    executionPlan: { version: 1, purpose: 'apparatus-development' },
    domain: 'lean-bench', ...(project.spec.leanProfile ? { leanProfile: project.spec.leanProfile } : {}), requireReview: true,
    catalog: project.spec.catalog, reviews: project.spec.reviews || [], runtimeSources: project.spec.runtimeSources,
    tasks: [task], conditions: [{ id: 'generated-control', label: 'Generated ' + job.kind + ' program', adapter: { kind: 'replay', responses: { control: code } } }],
    protocol: { seed: project.spec.protocol.seed, replicates: job.replicates, maxAttemptsPerTrial: 1, maxTotalAttempts: job.replicates,
      timeoutMs: budget.attemptTimeoutMs, maxDurationMs: budget.maxDurationMs, grading: { kind: 'lean-python', executionTimeoutMs: budget.executionTimeoutMs } },
    inputs: [...project.spec.inputs, { path: bindingPath, sha256: await sha256(canonical(binding) + '\n') }], environment: project.spec.environment,
    analysisPlan: { version: 1, cohort: 'qualification', primaryDenominator: 'scheduled', primaryPopulation: 'all',
      rationale: 'Every scheduled control replicate remains in the development denominator. This auxiliary project is not the parent experiment.', contrasts: [], multiplicity: 'none-descriptive', uncertainty: null },
    decisions: 'Generated from frozen parent ' + project.sha256 + ', native plan ' + plan.sha256 + ', job ' + jobId + '. Inspect native-control/binding.json and retain the parent project. ' + binding.scope }
  const controlProject = await freezeStudy(spec), compiled = controlProject.tasks[0]
  invariant(canonical(compiled.compiled.semantic) === canonical(program.compiled.semantic) && canonical(compiled.input) === canonical(program.input)
    && canonical(compiled.expected) === canonical(program.expected), 'The auxiliary project changed its registered program task or expected observation.')
  const body = { format: 'benchmark-native-control-job', version: 1, parentProjectSha256: project.sha256, nativePlanSha256: plan.sha256,
    jobId, binding, controlProject, controlProjectSha256: controlProject.sha256, programSha256 }
  return captureNative({ ...body, sha256: await sha256(canonical(body)) })
}

export async function verifyNativeControl(input, { runtimeFiles, inputFiles = {} } = {}) {
  const captured = captureNative({ input, runtimeFiles, inputFiles })
  invariant(object(captured.input) && Object.keys(captured.input).every(key => ['parentProject', 'control'].includes(key)), 'Native control verification needs the parent project and exact generated control envelope.')
  const expected = await materializeNativeControl(captured.input.parentProject, captured.input.control?.jobId,
    { runtimeFiles: captured.runtimeFiles, inputFiles: captured.inputFiles })
  invariant(canonical(expected) === canonical(captured.input.control), 'The native control differs from its regenerated parent-bound apparatus.')
  return expected
}
function nativeAttemptTask(project, attempt) {
  invariant(object(attempt) && Number.isSafeInteger(attempt.attempt) && attempt.attempt >= 1 && attempt.attempt <= project.spec.protocol.maxAttemptsPerTrial && attempt.attempt <= project.spec.protocol.maxTotalAttempts, 'Native evidence has an invalid attempt number or budget.')
  const trial = project.schedule.find(row => row.id === attempt.trialId), task = project.tasks.find(row => row.id === trial?.taskId)
  invariant(trial && task, 'Native evidence has an unknown scheduled trial or task.')
  invariant(attempt.projectSha256 === undefined || attempt.projectSha256 === project.sha256, 'Native evidence has a different frozen project binding.')
  invariant(attempt.type === undefined || attempt.type === 'finished', 'Native attempt evidence must describe a finished attempt.')
  invariant(attempt.status === undefined || attempt.status === 'completed', 'Native attempt verification requires a completed result; use journal verification to retain other outcomes.')
  invariant(object(attempt.response) && Object.hasOwn(attempt.response, 'output') && object(attempt.grade), 'Native evidence needs its retained response and grade.')
  return task
}
// The candidate that ran is archived beside its evidence: candidate.py under the operational harness,
// main.py otherwise, each the program plus the single newline the grader wrote.
function archivedCandidate(operational, read) {
  const archived = read(operational ? 'candidate.py' : 'main.py')
  invariant(archived.endsWith('\n'), 'The archived native candidate must end with the single trailing newline the grader wrote.')
  return archived.slice(0, -1)
}
function recordsCandidate(attempt) { return typeof attempt.grade?.candidateSha256 === 'string' }
function nativeAnswer(task, attempt, policy) {
  const decoded = task.information ? decodeInformationResponse(task, attempt.response.output) : { behavior: 'answer', answer: attempt.response.output }
  if (decoded.behavior !== 'answer') return { disposition: 'non-answer', grade: informationDisposition(decoded), code: null }
  try { return { disposition: 'program', code: extractSource(decoded.answer, policy) } }
  catch (error) { const classification = sourceFailureClassification(error); return { disposition: classification, code: null, grade: { passed: false, score: 0, classification, reason: error.message } } }
}
export function nativeEvidencePaths(project, attempts) {
  nativeProjectContract(project)
  invariant(Array.isArray(attempts), 'Native evidence needs a list of completed attempts.')
  const files = [], seen = new Set()
  const add = (key, location, path, required = true) => {
    invariant(safePath(key) && safePath(path) && !seen.has(key.toLowerCase()), 'Native evidence paths must be safe, distinct and without case collisions.')
    seen.add(key.toLowerCase()); files.push({ key, location, path, required, maxBytes: NATIVE_EVIDENCE_LIMITS.fileBytes })
  }
  for (const file of RUNTIME_FILES) add(`runtime/${file}`, 'project', file)
  for (const input of project.spec.inputs) add(`inputs/${input.path}`, 'project', input.path)
  const identities = new Set()
  for (const attempt of attempts) {
    const task = nativeAttemptTask(project, attempt), id = `${attempt.trialId}-${attempt.attempt}`
    invariant(!identities.has(id), 'Each native attempt must appear once; duplicate evidence is not allowed.'); identities.add(id)
    // Versioned with the archive: an attempt whose retained grade records a candidate hash ran a program
    // and must carry its artifacts, whatever the extractor imported now would make of the reply.
    if (!recordsCandidate(attempt) || nativeAnswer(task, attempt, extractionPolicyFor(project.spec)).disposition === 'non-answer') continue
    const prefix = `native/${id}`, directory = `artifacts/${id}`
    for (const name of ['main.py', ...(task.compiled.operational ? ['candidate.py', 'trading_broker.py'] : [])]) add(`${prefix}/${name}`, 'results', `${directory}/algorithm/${name}`)
    for (const name of ['config.json', 'execution.json']) add(`${prefix}/${name}`, 'results', `${directory}/${name}`)
    add(`${prefix}/result.json`, 'results', `${directory}/results/${id}.json`, false)
    add(`${prefix}/order-events.json`, 'results', `${directory}/results/${id}-order-events.json`, false)
  }
  return { version: 1, projectSha256: project.sha256, files, limits: NATIVE_EVIDENCE_LIMITS }
}
async function nativeFiles(project, attempts, files) {
  const plan = nativeEvidencePaths(project, attempts), expected = new Map(plan.files.map(row => [row.key, row]))
  invariant(object(files), 'Native evidence requires a file map.')
  const seen = new Set(), decoded = new Map()
  for (const [key, value] of Object.entries(files)) {
    invariant(safePath(key) && expected.has(key) && !seen.has(key.toLowerCase()), `Native evidence has an unexpected file path or case collision: ${key}.`)
    seen.add(key.toLowerCase())
    // Guard text/base64 length before decoding, then enforce the actual byte cap.
    invariant(typeof value !== 'string' || value.length <= NATIVE_EVIDENCE_LIMITS.fileBytes, `Native evidence file ${key} exceeds the 16 MiB file byte limit.`)
    invariant(typeof value?.data !== 'string' || value.data.length <= 4 * Math.ceil(NATIVE_EVIDENCE_LIMITS.fileBytes / 3) + 4, `Native evidence file ${key} exceeds the 16 MiB file byte limit.`)
    const bytes = auditFileBytes(value)
    invariant(bytes.byteLength <= NATIVE_EVIDENCE_LIMITS.fileBytes, `Native evidence file ${key} exceeds the 16 MiB file byte limit.`)
    decoded.set(key, bytes)
  }
  invariant(plan.files.every(row => !row.required || decoded.has(row.key)), 'Native evidence omits a required source, input or candidate file.')
  const hashes = Object.fromEntries(await Promise.all([...decoded].map(async ([key, bytes]) => [key, await sha256(bytes)])))
  for (const [file, expectedHash] of Object.entries(project.spec.runtimeSources)) invariant(hashes[`runtime/${file}`] === expectedHash, `The pinned runtime source changed: ${file}.`)
  for (const input of project.spec.inputs) invariant(hashes[`inputs/${input.path}`] === input.sha256, `The pinned source input changed: ${input.path}.`)
  return { decoded, hashes, sourceFileHashes: Object.fromEntries(Object.entries(hashes).filter(([key]) => !key.startsWith('native/'))) }
}
async function nativeAttemptReceipt(project, attempt, bound) {
  const task = nativeAttemptTask(project, attempt), answer = nativeAnswer(task, attempt, extractionPolicyFor(project.spec)), id = `${attempt.trialId}-${attempt.attempt}`, prefix = `native/${id}/`
  const artifactFileHashes = Object.fromEntries(Object.entries(bound.hashes).filter(([key]) => key.startsWith(prefix)))
  let disposition = answer.disposition, observation = null, reconstructedGrade = answer.grade, candidateSha256 = null
  const read = name => {
    const bytes = bound.decoded.get(prefix + name)
    invariant(bytes, `Native evidence omits required ${name} for observation reconstruction.`)
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  // Versioned with the archive, exactly as the judge-audit path above: a recorded candidate hash means a
  // program ran, and its bytes are the archived artifact rather than a re-extraction of the reply.
  const recorded = recordsCandidate(attempt) && answer.disposition !== 'non-answer'
  const code = recorded ? archivedCandidate(!!task.compiled.operational, read) : answer.code
  let extractionNotice = null
  if (recorded) {
    disposition = 'program'
    if (answer.code === null) extractionNotice = 'The extractor imported now refuses this reply; the archived program is authoritative.'
    else if (answer.code !== code) extractionNotice = 'The extractor imported now does not reproduce the archived program; the archived program is authoritative.'
  }
  if (code !== null) {
    candidateSha256 = await sha256(code)
    const programs = task.compiled.operational ? operationalCandidateFiles(task, code, {
      'trading_broker.py': new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bound.decoded.get('runtime/trading_broker.py')),
    }) : { 'main.py': code + '\n' }
    for (const [name, program] of Object.entries(programs)) invariant(read(name) === program, 'The native candidate program or public harness differs from its frozen source contract.')
    invariant(attempt.grade.candidateSha256 === candidateSha256, 'The archived native program differs from the retained candidate hash.')
    invariant(canonical(JSON.parse(read('config.json'))) === canonical(leanConfig(id)), 'The native configuration differs from its frozen attempt contract.')
    const execution = JSON.parse(read('execution.json'))
    invariant(object(execution) && Object.keys(execution).length === 4 && ['exitCode', 'signal', 'stdout', 'stderr'].every(key => Object.hasOwn(execution, key)) && typeof execution.stdout === 'string' && typeof execution.stderr === 'string', 'Native evidence needs the exact process execution record and text output.')
    invariant(Number.isSafeInteger(execution.exitCode) && execution.exitCode >= 0 && execution.signal === null, 'Unsupported or incomplete native execution proof: signals, timeouts and unknown process completion cannot be verified.')
    invariant(![125, 126, 127].includes(execution.exitCode), 'Unsupported native execution proof: infrastructure exit codes do not establish an engine result.')
    invariant(attempt.grade.candidateSha256 === candidateSha256, 'The native candidate hash differs from its retained response.')
    invariant(attempt.grade.directory === `artifacts/${id}`, 'The native grade directory differs from its frozen attempt.')
    invariant(attempt.grade.image === project.spec.environment.leanImage, 'The native grade image differs from its frozen declaration.')
    invariant(canonical(attempt.grade.execution) === canonical(execution), 'The native grade execution record differs from its retained process bytes.')
    // A grade that records its container arguments must record exactly this runtime's;
    // grades written before the runtime recorded them carry none.
    const evidence = { directory: `artifacts/${id}`, image: project.spec.environment.leanImage, candidateSha256, execution,
      ...(Object.hasOwn(attempt.grade, 'container') ? { container: leanContainerRecord({ projectSha256: project.sha256, image: project.spec.environment.leanImage }) } : {}) }
    if (execution.exitCode === 0) {
      const eventsPresent = bound.decoded.has(prefix + 'order-events.json')
      observation = nativeObservation(JSON.parse(read('result.json')), eventsPresent ? JSON.parse(read('order-events.json')) : null, task)
      const grade = task.information ? gradeInterpretations(task, observation, 'json') : (() => {
        const passed = canonical(observation) === canonical(task.expected)
        return { passed, score: passed ? 1 : 0, classification: passed ? 'correct' : 'trace-mismatch' }
      })()
      reconstructedGrade = { ...grade, trace: observation, files: [id + '.json', ...(eventsPresent ? [id + '-order-events.json'] : [])], ...evidence }
      disposition = 'observed'
    } else {
      reconstructedGrade = { passed: false, score: 0, classification: 'execution-error', ...evidence }
      disposition = 'execution-failure'
    }
  }
  invariant(canonical(attempt.grade) === canonical(reconstructedGrade), 'The retained native grade, trace, files or interpretation attribution disagrees with the reconstructed execution or disposition contract.')
  const receipt = { ...nativeReceipt('benchmark-native-attempt-verification', project), trialId: attempt.trialId, attempt: attempt.attempt,
    profile: task.compiled.operational ? 'operational-v1' : 'synchronous-v1', responseSha256: await sha256(canonical(attempt.response)), candidateSha256,
    ...(extractionNotice ? { extractionNotice } : {}),
    disposition, observation, reconstructedGrade, sourceFileHashes: bound.sourceFileHashes, artifactFileHashes }
  return { ...receipt, evidenceSha256: await sha256(canonical(receipt)) }
}
export async function verifyNativeAttemptEvidence(input) {
  const { project, attempt, files } = captureNative(input)
  nativeProjectContract(project)
  await verifyProject(project)
  const bound = await nativeFiles(project, [attempt], files)
  return captureNative(await nativeAttemptReceipt(project, attempt, bound))
}
export async function verifyNativeJournalEvidence(input) {
  const { project, events, files } = captureNative(input)
  nativeProjectContract(project)
  await verifyProject(project)
  await verifyQualificationJournal(project, events)
  await verifyResourceJournal(project, events)
  invariant(validateJournal(project, events).length === 0, 'Finish or explicitly recover open attempts before verifying native journal evidence.')
  const completions = events.filter(event => event.type === 'finished' && event.status === 'completed')
  const bound = await nativeFiles(project, completions, files), attempts = []
  for (const attempt of completions) attempts.push(await nativeAttemptReceipt(project, attempt, bound))
  return captureNative({ ...nativeReceipt('benchmark-native-journal-verification', project), journalSha256: await sha256(canonical(events)), filesSha256: await sha256(canonical(bound.hashes)), attempts })
}

export function validateAuditPlan(plan) {
  invariant(object(plan) && plan.version === AUDIT_VERSION, 'Judge audits need a version 1 plan.')
  fields(plan, ['version', 'reference', 'rationale', 'criterion', 'selection', 'provenance', 'projection'], 'Judge audit plan')
  invariant(text(plan.rationale), 'Explain the audit case selection and intended claim.')
  invariant(object(plan.criterion) && ['frozen-grader', 'admissible-witness', 'declared-determinacy'].includes(plan.criterion.kind) && text(plan.criterion.statement), 'Declare the judge criterion and comparison scope.')
  fields(plan.criterion, ['kind', 'statement'], 'Audit criterion')
  invariant(object(plan.selection) && ['all', 'seeded'].includes(plan.selection.kind) && Number.isSafeInteger(plan.selection.seed) && plan.selection.seed >= 0 && plan.selection.seed <= 0xffffffff && Number.isSafeInteger(plan.selection.limit) && plan.selection.limit >= 1 && plan.selection.limit <= 512, 'Declare all or seeded audit selection, a 32-bit seed and a 1–512 case limit.')
  fields(plan.selection, ['kind', 'seed', 'limit'], 'Audit selection')
  invariant(object(plan.provenance) && ['canonical-study', 'generated-controls', 'external-benchmark'].includes(plan.provenance.kind) && text(plan.provenance.title) && text(plan.provenance.version) && Array.isArray(plan.provenance.sourcePaths), 'Declare the benchmark title, version, origin and pinned source paths.')
  fields(plan.provenance, ['kind', 'title', 'version', 'sourcePaths', 'citation', 'acquisition'], 'Audit provenance')
  invariant(plan.provenance.citation === undefined || text(plan.provenance.citation), 'A supplied citation must be text.')
  invariant(plan.provenance.sourcePaths.every(safePath) && new Set(plan.provenance.sourcePaths).size === plan.provenance.sourcePaths.length, 'Audit provenance paths must be distinct source input paths.')
  if (plan.provenance.kind === 'external-benchmark') invariant(plan.provenance.sourcePaths.length > 0, 'External benchmark provenance needs pinned source bytes; a name or URL alone is insufficient.')
  if (plan.provenance.kind === 'external-benchmark' || plan.provenance.acquisition !== undefined) {
    const acquisition = plan.provenance.acquisition
    invariant(object(acquisition) && text(acquisition.method) && text(acquisition.location) && text(acquisition.at) && Number.isFinite(Date.parse(acquisition.at)), 'Declare how, where and when the external benchmark source was acquired.')
    fields(acquisition, ['method', 'location', 'at'], 'Source acquisition')
  }
  invariant(object(plan.projection) && ['compiled-prompt', 'original-prompt-file'].includes(plan.projection.prompt) && typeof plan.projection.includeInput === 'boolean', 'Declare the original prompt projection and whether frozen input is visible to the judge.')
  fields(plan.projection, ['prompt', 'includeInput'], 'Audit request projection')
  if (plan.provenance.kind === 'external-benchmark') invariant(plan.projection.prompt === 'original-prompt-file', 'An external benchmark audit must project the pinned original prompt, while retaining any semantic reconstruction separately.')
  return plan
}

export function auditCatalog() {
  return [{ id: 'judge-instruction', version: '1', kind: 'atom', role: 'node', parameters: { criterion: '', task: '', candidate: '' },
    text: 'Evaluate the candidate under this criterion:\n{{criterion}}\n\nOriginal task:\n{{task}}\n\nCandidate response:\n{{candidate}}', semantics: { kind: 'judge-audit', task: '{{task}}', candidate: '{{candidate}}', criterion: '{{criterion}}' } }]
}
export function auditPlanFromReference(reference) {
  return { version: AUDIT_VERSION, reference, rationale: 'Draft audit of recorded candidates. Review source provenance, comparison scope and selection before judging.',
    criterion: { kind: 'frozen-grader', statement: 'Accept a candidate that meets the original task’s frozen observation criterion; reject one that fails that criterion. Report undetermined when the criterion cannot determine a verdict, or abstain when you cannot assess it.' },
    selection: { kind: 'all', seed: 42, limit: 512 }, provenance: { kind: 'canonical-study', title: reference.project.spec.name, version: reference.project.sha256, sourcePaths: [] },
    projection: { prompt: 'compiled-prompt', includeInput: true } }
}
export async function auditStudyFromReference(reference, { generate = true } = {}) {
  await verifyAuditReference(reference)
  const spec = genericStarter()
  spec.id = (reference.project.spec.id.slice(0, 57) + '-audit')
  spec.name = `Judge audit: ${reference.project.spec.name}`
  spec.requireReview = true; spec.catalog = auditCatalog(); spec.auditPlan = auditPlanFromReference(reference)
  spec.protocol.grading = { kind: 'judge-audit' }
  spec.analysisPlan.primaryPopulation = 'reference-eligible'
  spec.analysisPlan.rationale = 'Draft audit protocol. Primary agreement rates use cases with reference labels fixed before judge collection. Keep unresolved references, abstentions and collection failures visible.'
  spec.conditions[0] = { id: 'judge', label: 'Judge to be configured', model: { provider: 'undeclared', id: 'undeclared', settings: {} }, adapter: { kind: 'replay', responses: {} } }
  spec.tasks = generate ? (await materializeAudit(spec.auditPlan)).tasks : [{ id: 'audit-draft', familyId: 'audit-draft', split: 'development', root: { use: 'judge-instruction' }, expected: null, input: null }]
  return spec
}

export function auditAnalysis(project, rows) {
  if (!project.audit) return null
  const ratio = (n, d) => d ? n / d : null
  const groups = project.spec.conditions.map(condition => {
    const subset = rows.filter(row => row.conditionId === condition.id), eligible = subset.filter(row => row.referenceEligible), completed = eligible.filter(row => row.status === 'completed')
    const count = (expected, verdict) => completed.filter(row => row.audit.referenceVerdict === expected && row.audit.judgeVerdict === verdict).length
    const rejected = eligible.filter(row => row.audit.referenceVerdict === 'reject'), rejectedCompleted = rejected.filter(row => row.status === 'completed')
    const accepted = eligible.filter(row => row.audit.referenceVerdict === 'accept'), acceptedCompleted = accepted.filter(row => row.status === 'completed')
    const confusion = ['accept', 'reject', 'undetermined', null].flatMap(expected => [...AUDIT_VERDICTS, null].map(verdict => ({ referenceVerdict: expected, judgeVerdict: verdict,
      count: subset.filter(row => row.status === 'completed' && row.audit.referenceVerdict === expected && row.audit.judgeVerdict === verdict).length })))
    return { condition: condition.id, scheduled: subset.length, completed: subset.filter(row => row.status === 'completed').length, eligibleScheduled: eligible.length, eligibleCompleted: completed.length,
      unresolvedReferences: subset.filter(row => !row.referenceEligible).length, agreements: completed.filter(row => row.passed).length,
      correctRejections: count('reject', 'reject'), falseAcceptances: count('reject', 'accept'), falseRejections: count('accept', 'reject'),
      rejectionDetectionScheduled: ratio(count('reject', 'reject'), rejected.length), rejectionDetectionCompleted: ratio(count('reject', 'reject'), rejectedCompleted.length),
      falseAcceptanceCompleted: ratio(count('reject', 'accept'), rejectedCompleted.length), falseRejectionCompleted: ratio(count('accept', 'reject'), acceptedCompleted.length), confusion }
  })
  return { version: AUDIT_VERSION, ...project.audit, groups,
    scope: project.spec.auditPlan.criterion.kind,
    limitations: [
      'Judge agreement is relative to the frozen comparison criterion and supplied reference evidence. It is not a universal claim about natural-language correctness or the judge’s performance on unselected tasks.',
      'Reference eligibility is fixed before judge collection. Unresolved reference cases retain null scores and remain in the disposition ledger; they cannot become judge mistakes or evidence of semantic uniqueness.',
      'Imported artifacts and review records establish reproducible bindings, not cryptographic proof of who executed a program or approved its interpretation. Custom reference scores retain their recorded-grader basis.',
      'Candidate deduplication and sampling precede judge collection. The complete source trial ledger, including unmeasured, duplicated and unselected source cases, is retained.',
    ] }
}

function referenceVerdict(plan, task, completion) {
  const kind = plan.criterion.kind, grade = completion.grade
  if (kind === 'declared-determinacy') return task.informationPacket?.observableClasses.length >= 2
    ? { expected: 'undetermined', basis: 'multiple-declared-observable-classes' }
    : { expected: null, basis: 'finite-agreement-does-not-prove-determinacy' }
  const basis = task.information ? 'declared-interpretation-set' : plan.reference.project.spec.protocol.grading.kind === 'module' ? 'recorded-custom-grader' : 'frozen-observation-criterion'
  if (kind === 'admissible-witness') return grade.passed ? { expected: 'accept', basis } : { expected: null, basis: 'no-admissible-witness-established' }
  return { expected: grade.passed ? 'accept' : 'reject', basis }
}
function shuffled(rows, seed) {
  let state = seed >>> 0
  for (let i = rows.length - 1; i > 0; i--) {
    state += 0x6D2B79F5; let value = state
    value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    const j = Math.floor(((value ^ value >>> 14) >>> 0) / 4294967296 * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }
  return rows
}
export async function materializeAudit(plan) {
  validateAuditPlan(plan); await verifyAuditReference(plan.reference)
  const source = plan.reference.project, ledger = [], candidates = new Map()
  for (const path of plan.provenance.sourcePaths) invariant(Object.hasOwn(plan.reference.files, `inputs/${path}`), `Pin original benchmark source ${path} in the reference project's input manifest.`)
  const ends = new Map(), lastEnds = new Map()
  for (const event of plan.reference.events.filter(row => row.type === 'finished')) lastEnds.set(event.trialId, event)
  for (const event of plan.reference.events.filter(row => row.type === 'finished' && row.status === 'completed')) ends.set(event.trialId, event)
  for (const trial of source.schedule) {
    const task = source.tasks.find(row => row.id === trial.taskId), completion = ends.get(trial.id)
    const last = lastEnds.get(trial.id), responseRetained = Object.hasOwn(last?.response || {}, 'output')
    const row = { sourceTrialId: trial.id, sourceTaskId: task.id, sourceAttempt: completion?.attempt ?? null, sourceStatus: last?.status || 'not-attempted', sourcePhase: last?.phase || null,
      responseRetained, disposition: responseRetained ? 'source-ungraded-response' : 'source-unmeasured' }
    ledger.push(row)
    if (!completion) continue
    let prompt = task.compiled.text
    if (plan.projection.prompt === 'original-prompt-file') {
      const path = task.provenance?.originalPromptPath
      invariant(safePath(path) && Object.hasOwn(plan.reference.files, `inputs/${path}`), `${task.id}: pin its originalPromptPath as source input bytes before auditing external wording.`)
      invariant(plan.provenance.sourcePaths.includes(path), `${task.id}: include its original prompt in the declared provenance source paths.`)
      prompt = auditFileText(plan.reference, `inputs/${path}`)
    }
    const input = plan.projection.includeInput ? task.input ?? null : null, candidate = completion.response.output
    const identity = await sha256(canonical({ prompt, input, candidate, criterion: plan.criterion })), id = 'audit-' + identity.slice(0, 32)
    const reference = referenceVerdict(plan, task, completion)
    row.auditTaskId = id; row.expectedVerdict = reference.expected; row.referenceBasis = reference.basis
    if (candidates.has(identity)) {
      const prior = candidates.get(identity)
      invariant(prior.task.expected === reference.expected, 'Identical judge inputs have conflicting reference verdicts. Resolve the source ambiguity before auditing them.')
      invariant(prior.task.familyId === (task.familyId || task.id) && prior.task.split === task.split, 'Identical judge inputs span different source families or splits. Group source aliases in one family and split before auditing them.')
      row.disposition = 'duplicate-excluded'; prior.task.audit.origins.push({ trialId: trial.id, attempt: completion.attempt }); continue
    }
    row.disposition = 'eligible'
    const derived = { id, root: { use: 'judge-instruction' }, variables: { criterion: plan.criterion.statement, task: prompt, candidate: typeof candidate === 'string' ? candidate : canonical(candidate) }, input,
      expected: reference.expected, familyId: task.familyId || task.id, split: task.split,
      factors: { source_task: task.id, reference_basis: reference.basis, reference_verdict: reference.expected || 'unresolved' },
      audit: { version: AUDIT_VERSION, referenceSha256: plan.reference.sha256, sourceTaskId: task.id, origins: [{ trialId: trial.id, attempt: completion.attempt }],
        candidateSha256: await sha256(canonical(candidate)), originalPromptSha256: await sha256(prompt), reconstructedPromptSha256: task.compiled.promptSha256,
        referenceVerdict: reference.expected, referenceBasis: reference.basis, sourceGrade: completion.grade } }
    candidates.set(identity, { row, task: derived })
  }
  const pool = [...candidates.values()]
  if (plan.selection.kind === 'all') invariant(pool.length <= plan.selection.limit, 'The source contains more unique candidates than the frozen audit limit. Declare a sampling policy or raise the limit.')
  else shuffled(pool, plan.selection.seed)
  const selected = pool.slice(0, plan.selection.limit)
  for (let i = 0; i < pool.length; i++) pool[i].row.disposition = i < plan.selection.limit ? 'selected' : 'sample-excluded'
  invariant(selected.length > 0, 'The source has no completed candidates for an audit; no reference answer was inferred.')
  const recipe = { ...plan, reference: { sha256: plan.reference.sha256 } }
  const manifest = { format: 'benchmark-judge-audit', version: AUDIT_VERSION, planSha256: await sha256(canonical(recipe)), referenceSha256: plan.reference.sha256,
    sourceTrials: source.schedule.length, uniqueCandidates: candidates.size, selectedCases: selected.length, referenceEligibleCases: selected.filter(row => row.task.expected !== null).length,
    criterion: plan.criterion, provenance: plan.provenance, projection: plan.projection, selection: plan.selection, sourceSelection: 'first-completed', ledger }
  return { tasks: selected.map(row => row.task), manifest, sha256: await sha256(canonical(manifest)) }
}

export async function auditReviewPacket(project, task) {
  const source = project.spec.auditPlan.reference.project, subject = source.tasks.find(row => row.id === task.audit.sourceTaskId)
  const packet = { format: 'benchmark-audit-review', version: AUDIT_VERSION, taskId: task.id, familyId: task.familyId, split: task.split,
    prompt: task.compiled.text, promptSha256: task.compiled.promptSha256, input: task.input, criterion: project.spec.auditPlan.criterion,
    provenance: project.spec.auditPlan.provenance, projection: project.spec.auditPlan.projection, audit: task.audit,
    referenceBundleSha256: project.spec.auditPlan.reference.sha256, manifestSha256: project.audit.sha256,
    referenceTask: { prompt: subject.compiled.text, semantic: subject.compiled.semantic, expected: subject.expected, input: subject.input ?? null, information: subject.informationPacket || null },
    ...(project.spec.observationPlan ? { observationPlan: project.spec.observationPlan, observationConditions: project.spec.conditions.map(condition => ({ id: condition.id, model: condition.model || null, collection: condition.collection || null, adapterKind: condition.adapter.kind })) } : {}),
    referenceGrader: source.spec.protocol.grading, referenceEnvironment: source.spec.environment || {},
    runtimeSources: project.spec.runtimeSources || {}, grader: project.spec.protocol.grading, protocol: project.spec.protocol, analysisPlan: project.spec.analysisPlan || null,
    bundles: task.compiled.bundles.map(({ id, hash, rootSha256 }) => ({ id, hash, rootSha256 })) }
  return { ...packet, sha256: await sha256(canonical(packet)) }
}
export async function createAuditReviewRecord(task, reviewer, at = new Date().toISOString()) {
  invariant(task.auditPacket?.sha256 && text(reviewer) && Number.isFinite(Date.parse(at)), 'Prepare the audit packet and supply a reviewer name and timestamp.')
  return { taskId: task.id, reviewer: reviewer.trim(), at, decision: 'approved', packetSha256: task.auditPacket.sha256 }
}
export function auditReviewStatus(task, records = []) {
  invariant(Array.isArray(records) && records.every(object), 'Audit review records must be an array.')
  const review = records.filter(row => row.taskId === task.id).at(-1)
  return { approved: review?.decision === 'approved' && text(review.reviewer) && Number.isFinite(Date.parse(review.at)) && review.packetSha256 === task.auditPacket?.sha256, review }
}
export function gradeJudge(task, output) {
  let value
  try { value = typeof output === 'string' ? JSON.parse(output) : output } catch {}
  const valid = object(value) && AUDIT_VERDICTS.includes(value.verdict) && (value.reason === undefined || typeof value.reason === 'string') && Object.keys(value).every(key => ['verdict', 'reason'].includes(key))
  const expected = task.audit.referenceVerdict, eligible = expected !== null
  const verdict = valid ? value.verdict : null
  return { passed: eligible ? verdict === expected : null, score: eligible ? (verdict === expected ? 1 : 0) : null, referenceEligible: eligible,
    classification: !valid ? 'malformed-judge-verdict' : verdict === 'abstain' ? 'judge-abstention' : !eligible ? 'reference-unresolved' : verdict === expected ? 'judge-agreement' : 'judge-disagreement',
    judgeVerdict: verdict, referenceVerdict: expected, referenceBasis: task.audit.referenceBasis }
}
export function auditProjectFiles(project) {
  if (!project.audit) return {}
  const files = { 'audit/reference-bundle.json': JSON.stringify(project.spec.auditPlan.reference, null, 2) + '\n',
    'audit/manifest.json': JSON.stringify(project.audit, null, 2) + '\n', 'audit/reviews.json': JSON.stringify(project.spec.auditReviews || [], null, 2) + '\n' }
  for (const task of project.tasks) files[`audit/packets/${task.id}.json`] = JSON.stringify(task.auditPacket, null, 2) + '\n'
  return files
}
