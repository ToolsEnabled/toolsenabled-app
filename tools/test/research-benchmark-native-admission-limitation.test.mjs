import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import * as report from '../../src/benchmark/report.mjs'

// Native LEAN admission is not part of this version. A study graded by native LEAN says so, in
// one factual line of its report's limitations; a study graded any other way does not carry it.
const sources = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const REVIEWER = 'NATIVE ADMISSION LIMITATION FIXTURE MARKER ONLY'
async function frozen(starter, lean) {
  const bytes = await sources()
  let spec = newExperimentDraft(starter(), { purpose: lean ? 'apparatus-development' : 'recorded-diagnostic' })
  if (lean) {
    spec.environment.leanImage = 'quantconnect/lean@sha256:' + 'a'.repeat(64)
    spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
    // lean-python grades a program, so the saved response is one; the grade is supplied directly.
    spec.conditions[0].adapter.responses = { 'flat-canary': '# LIMITATION FIXTURE MARKER PROGRAM; NEVER EXECUTED\n' }
  }
  spec = await bindRuntimeSources(spec, bytes)
  if (lean) spec = await bindLeanReview(spec, bytes)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const limitationsOf = markdown => {
  const text = unescapeMarkdown(markdown)
  const start = text.indexOf('Limitations and threats to validity')
  assert.ok(start >= 0, 'the report has its limitations section')
  const end = text.indexOf('Reproducibility checklist', start)
  return text.slice(start, end > start ? end : undefined)
}

test('the limitation line is one factual sentence pair and applies to native LEAN grading only', () => {
  assert.equal(typeof report.nativeAdmissionLimitation, 'function')
  assert.match(report.NATIVE_ADMISSION_LIMITATION, /^Native LEAN admission is not part of this version\. Until it ships, a native LEAN run is apparatus-development evidence, not an admitted experimental result\.$/)
  assert.deepEqual(report.nativeAdmissionLimitation({ protocol: { grading: { kind: 'lean-python' } } }), [report.NATIVE_ADMISSION_LIMITATION])
  for (const kind of ['module', 'behavior', 'exact', undefined]) assert.deepEqual(report.nativeAdmissionLimitation({ protocol: { grading: { kind } } }), [])
})

test('a study graded by native LEAN states the limitation in its report', async () => {
  const project = await frozen(leanStarter, true)
  assert.equal(project.spec.protocol.grading.kind, 'lean-python')
  const result = await runStudy(project, { grade: async () => ({ passed: true, score: 1, classification: 'passed', image: project.spec.environment.leanImage,
    candidateSha256: 'b'.repeat(64), execution: { exitCode: 0, stdout: '', stderr: '' }, trace: structuredClone(project.tasks[0].expected) }) })
  const files = await report.researchReportFiles(project, result.events)
  assert.ok(limitationsOf(files['report.md']).includes(report.NATIVE_ADMISSION_LIMITATION))
})

test('a study graded any other way does not carry it', async () => {
  const project = await frozen(genericStarter, false)
  assert.notEqual(project.spec.protocol.grading.kind, 'lean-python')
  const result = await runStudy(project)
  const files = await report.researchReportFiles(project, result.events)
  assert.ok(!limitationsOf(files['report.md']).includes(report.NATIVE_ADMISSION_LIMITATION))
})
