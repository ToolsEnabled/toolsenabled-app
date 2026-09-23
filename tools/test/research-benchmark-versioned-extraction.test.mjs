import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { approveBundle, canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { replayAdapter, runStudy } from '../../src/benchmark/runner.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { AUDIT_VERSION, verifyAuditReference, verifyNativeAttemptEvidence } from '../../src/benchmark/audit.mjs'
import { deriveReadinessContract, evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

// Re-verifying archived evidence used to apply the extractor imported RIGHT NOW to the retained reply.
// The extractor is itself a pinned runtime file, so changing it turned valid archived evidence into a
// verification failure. What actually ran is the archived program artifact, and the recorded candidate
// hash is bound to those bytes instead. Nothing here executes the archived runtime: the pinned extractor
// below is a byte-different revision of the current file, standing for whatever version graded the run,
// and the point of each test is the DISAGREEMENT between it and the extractor imported now.
const reviewer = 'SYNTHETIC VERSIONED-EXTRACTION TEST; NO INVESTIGATOR APPROVAL'
const at = '2026-09-09T00:00:00.000Z'
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const archivedExtractor = sources['lean-observations.mjs'] + '\n// Archived revision of this pinned file; never executed by verification.\n'
const archivedSources = { ...sources, 'lean-observations.mjs': archivedExtractor }

const program = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def Initialize(self):\n        self.SetStartDate(2020, 1, 1)\n'
// One program wrapped in prose. The extractor imported now refuses this shape as a format violation;
// the run that produced the evidence recorded a program for it, which is the disagreement under test.
const reply = 'Here is the algorithm.\n\n```python\n' + program + '```\n\nIt buys two shares on the first bar.'
const archivedCode = reply.trim()

async function archivedStudy() {
  let spec = developmentDraft(leanStarter())
  spec.protocol = { ...spec.protocol, grading: { kind: 'lean-python', executionTimeoutMs: 30000 },
    replicates: 1, maxAttemptsPerTrial: 1, maxTotalAttempts: 1 }
  spec.environment = { ...spec.environment, leanImage: 'synthetic-unavailable-image@sha256:' + 'a'.repeat(64) }
  spec.conditions = [{ id: 'archived-reply', adapter: { kind: 'replay', responses: { [spec.tasks[0].id]: reply } } }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, archivedSources), archivedSources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, reviewer, at, { catalog: spec.catalog })))
  const project = await freezeStudy(spec)
  const attemptId = `${project.schedule[0].id}-1`
  const execution = { exitCode: 1, signal: null, stdout: '', stderr: 'SyntaxError: invalid syntax\n' }
  const grade = { passed: false, score: 0, classification: 'execution-error', directory: `artifacts/${attemptId}`,
    image: project.spec.environment.leanImage, candidateSha256: await sha256(archivedCode), execution }
  const run = await runStudy(project, { adapter: replayAdapter, grade: async () => structuredClone(grade) })
  const files = {}
  for (const file of RUNTIME_FILES) files[`runtime/${file}`] = archivedSources[file]
  files[`native/${attemptId}/main.py`] = archivedCode + '\n'
  files[`native/${attemptId}/config.json`] = JSON.stringify(leanConfig(attemptId), null, 2) + '\n'
  files[`native/${attemptId}/execution.json`] = JSON.stringify(execution, null, 2) + '\n'
  const attempt = run.events.find(event => event.type === 'finished' && event.status === 'completed')
  return { project, events: run.events, files, attempt, attemptId }
}
// Provenance on demand: with RP5A_C3_EVIDENCE set, write a manifest of the bundle this file builds --
// what it pins, what it archives and what the two extractors make of the reply -- so a reviewer can see
// how the fixture was produced without the bundle being checked in and going stale against the runtime.
async function retain(subject) {
  const root = process.env.RP5A_C3_EVIDENCE
  if (!root) return
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  let currentReading = null
  try { const { pythonSource } = await import('../../src/benchmark/lean-observations.mjs'); currentReading = { extracted: await sha256(pythonSource(reply)) } }
  catch (error) { currentReading = { refused: error.message } }
  const manifest = {
    producedBy: 'tools/test/research-benchmark-versioned-extraction.test.mjs, built live from this tree',
    projectSha256: subject.project.sha256,
    pinnedRuntimeFiles: Object.keys(subject.project.spec.runtimeSources).length,
    pinnedExtractorSha256: subject.project.spec.runtimeSources['lean-observations.mjs'],
    extractorImportedNowSha256: await sha256(sources['lean-observations.mjs']),
    archivedProgramSha256: await sha256(archivedCode),
    recordedCandidateSha256: subject.attempt.grade.candidateSha256,
    recordedClassification: subject.attempt.grade.classification,
    replyBytes: Buffer.byteLength(reply),
    whatTheExtractorImportedNowMakesOfTheReply: currentReading,
    files: Object.fromEntries(await Promise.all(Object.entries(subject.files).map(async ([key, value]) => [key, await sha256(value)]))),
  }
  const target = resolve(root, 'rp5a-c3-red-bundle-manifest.json')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(manifest, null, 2) + '\n')
}
const sealed = async subject => {
  const payload = { format: 'benchmark-audit-reference', version: AUDIT_VERSION, project: subject.project, events: subject.events, files: subject.files }
  return { ...payload, sha256: await sha256(canonical(payload)) }
}

test('archived evidence verifies under an extractor it does not pin, and the recorded hash binds the archived program', async () => {
  const subject = await archivedStudy()
  assert.notEqual(await sha256(sources['lean-observations.mjs']), await sha256(archivedExtractor))
  const receipt = await verifyNativeAttemptEvidence({ project: subject.project, attempt: subject.attempt, files: subject.files })
  assert.equal(receipt.disposition, 'execution-failure')
  assert.equal(receipt.candidateSha256, await sha256(archivedCode))
  // The disagreement is reported rather than hidden, and it does not fail the verification.
  assert.match(receipt.extractionNotice, /refuses this reply|does not reproduce/)
  await retain(subject)
})

test('altering the archived program is refused, so the hash bind is a real check', async () => {
  const subject = await archivedStudy()
  const files = { ...subject.files, [`native/${subject.attemptId}/main.py`]: archivedCode + ' \n' }
  await assert.rejects(verifyNativeAttemptEvidence({ project: subject.project, attempt: subject.attempt, files }),
    /archived native program differs from the retained candidate hash|frozen source contract/)
})

test('a reference study pinning the other extractor verifies, and its absent-trace record is checked there', async () => {
  await verifyAuditReference(await sealed(await archivedStudy()))
  // Proof that the absent-trace branch ran: a classification outside its accepted set is refused there.
  const broken = await archivedStudy(), events = structuredClone(broken.events)
  for (const event of events) if (event.type === 'finished' && event.grade) event.grade.classification = 'incorrect'
  await assert.rejects(verifyAuditReference(await sealed({ ...broken, events })),
    /needs its trace or an explicit execution-failure record/)
})

test('readiness names the class the grader would actually record, derived from the extractor', async () => {
  const blockers = async response => {
    const spec = leanStarter()
    spec.schemaVersion = 2
    spec.executionPlan = { version: 1, purpose: 'apparatus-development' }
    Object.assign(spec.analysisPlan, { primaryPopulation: 'all', primaryDenominator: 'scheduled', uncertainty: null, multiplicity: 'none-descriptive' })
    spec.protocol.grading = { kind: 'lean-python' }
    spec.environment.leanImage = 'image@sha256:' + 'a'.repeat(64)
    spec.conditions[0].adapter.responses['flat-canary'] = response
    const tasks = await Promise.all(spec.tasks.map(task => compileTask(spec, task, { requireReview: false, requireTaskReview: false })))
    const schedule = tasks.flatMap(task => spec.conditions.map(condition => ({ id: `${task.id}.${condition.id}.1`, taskId: task.id, conditionId: condition.id, replicate: 1 })))
    const runtimeFiles = ['prompts.mjs', 'readiness.mjs']
    spec.runtimeSources = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, await sha256('static-unit-source:' + file)])))
    const project = { format: 'research-benchmark', version: 2, spec, tasks, schedule, runtimeFiles }
    project.readiness = await deriveReadinessContract(project)
    return evaluateReadiness(project, { operation: 'apparatus-development' }).blockers
      .filter(row => row.path.includes('flat-canary')).map(row => row.message)
  }
  const wrongShape = await blockers({ code: reply })
  assert.equal(wrongShape.length, 1)
  assert.match(wrongShape[0], /would record format-violation\b/)
  const noProgram = await blockers({ trace: [] })
  assert.equal(noProgram.length, 1)
  assert.match(noProgram[0], /would record no-program\b/)
})
