// Explicit real-engine service qualification; ordinary unit tests never run it.
// Usage: node tools/test/fixtures/qualify-research-benchmark-lean-service.mjs EVIDENCE_DIRECTORY ENGINE_SOURCE_ROOT
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approveBundle, compilePrompt, sha256 } from '../../../src/benchmark/prompts.mjs'
import { leanCatalog, leanStarter } from '../../../src/benchmark/lean.mjs'
import { bindLeanReview, inlineLeanProgram, generateLeanProgram, leanProjectFiles } from '../../../src/benchmark/lean-codegen.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { projectFiles, zipFiles } from '../../../src/benchmark/export.mjs'
import { exportedBenchmarkExperiment } from '../../../src/research-benchmark-dispatch.js'
import { runnerConfigFor } from '../../../src/research-experiments.js'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

const sourceRoot = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
const encode = value => JSON.stringify(value, null, 2) + '\n'
export async function qualifyLeanService(evidenceDirectory, engineSourceRoot) {
  const evidence = resolve(evidenceDirectory), engineRoot = resolve(engineSourceRoot)
  const extracted = join(evidence, 'standalone project'), artifactDir = join(evidence, 'native artifacts')
  await mkdir(evidence, { recursive: true }); await mkdir(artifactDir, { recursive: true })
  const require = createRequire(import.meta.url)
  const { createStateStore } = require(join(engineRoot, 'src/lib/state-store.js'))
  const { ResearchControl } = require(join(engineRoot, 'src/lib/providers/research.js'))
  const { runProcess } = require(join(engineRoot, 'src/lib/research/runners.js'))
  const { collect } = require(join(engineRoot, 'src/lib/research/collectors.js'))
  const { assertProcessReceipt } = require(join(engineRoot, 'src/lib/research/provenance.js'))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(join(sourceRoot, file), 'utf8')])))
  let spec = leanStarter()
  spec.id = 'lean-service-apparatus-fixture'; spec.name = 'Synthetic Lean process service qualification'
  spec.decisions = 'Synthetic test fixture only. All review markers refer to this apparatus test and approve no personal atom catalog or counted study. No provider is contacted.'
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec.protocol = { ...spec.protocol, replicates: 1, maxAttemptsPerTrial: 1, maxTotalAttempts: 1, timeoutMs: 45000, maxDurationMs: 60000, grading: { kind: 'lean-python', executionTimeoutMs: 30000 } }
  const task = spec.tasks[0], compiled = await compilePrompt(leanCatalog(), task.root)
  const candidate = inlineLeanProgram(generateLeanProgram({ ...task, compiled }), sources)
  spec.conditions = [{ id: 'known-correct', label: 'Synthetic known correct Python', model: { provider: 'fixture', id: 'known-correct', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: candidate } } }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, 'SYNTHETIC SERVICE APPARATUS FIXTURE ONLY', '2026-09-08T00:00:00.000Z', { catalog: spec.catalog })))
  const project = await freezeStudy(spec), extras = leanProjectFiles(project, sources['lean-reference.py'], sources['execution_reference.py'])
  for (const task of project.tasks) extras[`lean/${task.id}/lean_reference.py`] = sources['lean-reference.py']
  const files = await projectFiles(project, { ...sources, ...extras })
  const archive = join(evidence, 'standalone-project.zip')
  await writeFile(archive, zipFiles(files))
  for (const [file, text] of Object.entries(files)) {
    const path = join(extracted, file)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, text)
  }

  const state = createStateStore({ file: join(evidence, 'fixture-research.sqlite3') })
  let report = { kind: 'lean-native-service-qualification', countedStudy: false, atomsApproved: false,
    engineRoot, image: QUALIFICATION_IMAGE, projectSha256: project.sha256, zipSha256: await sha256(await readFile(archive)), runtimeSources: project.spec.runtimeSources }
  try {
    state.health()
    // Policy/audit admission alone is synthetic. SQLite registration,
    // immutable byte pins, native process custody and collection are real.
    const enabled = { state: 'enabled', why: null }
    const control = new ResearchControl({ state, gate: () => ({ pipelineWithheld: false, pipeline: enabled, runners: { process: enabled } }), auditRequire: () => ({ durable: true }) })
    const { project: serviceProject } = control.projectSave({ actor: 'human', name: 'SYNTHETIC LEAN SERVICE FIXTURE', enabled: true })
    const declaration = await exportedBenchmarkExperiment({ project, files, directory: extracted, command: process.execPath, projectId: serviceProject.projectId })
    const submitted = control.runSubmit({ actor: 'human', params: { benchmark: project.sha256.slice(0, 12) }, experiment: {
      projectId: serviceProject.projectId, name: declaration.name, runnerKind: 'process', runnerConfig: runnerConfigFor(declaration.runner),
      timeoutMs: declaration.timeoutMs, collector: { kind: 'stdout-json', recordKind: 'summary' }, resultSchema: declaration.resultSchema,
    } })
    await writeFile(join(evidence, 'service-declaration.json'), encode({ declaration, submitted }))
    const stored = state.getResearchExperiment({ experimentId: submitted.experiment.experimentId })
    console.log('Running the current exported Lean project through the actual staged process runner')
    const outcome = await runProcess({ experiment: stored, run: submitted.run, artifactDir })
    await writeFile(join(evidence, 'process-outcome.json'), encode(outcome))
    assert.equal(outcome.failure, null, encode({ failure: outcome.failure, stderr: outcome.stderr }))
    assert.equal(outcome.exitCode, 0, outcome.stderr)
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.stdoutTruncated, false)
    assert.equal(outcome.processLifecycle.acceptanceReady, true)
    if (process.platform === 'linux') {
      assert.equal(outcome.processLifecycle.backend, 'linux-subreaper-pidfd-v2')
      assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY')
      assert.equal(outcome.processLifecycle.receipt.observedChildren, outcome.processLifecycle.receipt.reapedChildren)
      assert.ok(outcome.processLifecycle.receipt.observedChildren >= 1, 'The native guardian must observe the CLI root; the CLI reaps its own helpers')
    }
    assertProcessReceipt(outcome.provenance, { pins: stored.runnerConfig.pinnedFiles, runId: submitted.run.runId, artifactDir })
    const collected = collect({ collector: stored.collector, resultSchema: stored.resultSchema, stdout: outcome.stdout, artifactDir })
    await writeFile(join(evidence, 'collected.json'), encode(collected))
    assert.deepEqual(collected.refused, []); assert.equal(collected.dropped, 0); assert.equal(collected.records.length, 1)
    const [{ recordKind, record }] = collected.records
    assert.equal(recordKind, 'summary'); assert.equal(record.completed, 1); assert.equal(record.failed, 0); assert.equal(record.scheduled, 1)
    assert.equal(record.evidence, join(artifactDir, 'evidence.json'))
    const result = JSON.parse(await readFile(record.evidence, 'utf8'))
    assert.equal(result.summary.groups[0].passed, 1)
    const finished = result.events.filter(event => event.type === 'finished')
    assert.equal(finished.length, 1); assert.equal(finished[0].grade.classification, 'correct')
    assert.deepEqual(finished[0].grade.trace, task.expected)
    const retained = JSON.parse(await readFile(join(artifactDir, 'responses', `${finished[0].trialId}-${finished[0].attempt}.json`), 'utf8'))
    assert.equal(retained.response.output, candidate)
    assert.equal(retained.projectSha256, project.sha256)
    report = { ...report, status: 'passed', completed: 1, nativeFills: finished[0].grade.trace.length, collectedRecords: 1,
      artifactPathsCorrect: true, durableResponseRetained: true, environmentKeys: outcome.provenance.invocation.environmentKeys,
      processLifecycle: outcome.processLifecycle, pinnedFiles: stored.runnerConfig.pinnedFiles }
    await writeFile(join(evidence, 'qualification.json'), encode(report))
    console.log(encode(report))
    return report
  } catch (error) {
    await writeFile(join(evidence, 'qualification.json'), encode({ ...report, status: 'failed', reason: error.message }))
    throw error
  } finally { state.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass evidence directory and staged engine source root; this runs real local Docker.')
  await qualifyLeanService(process.argv[2], process.argv[3])
}
