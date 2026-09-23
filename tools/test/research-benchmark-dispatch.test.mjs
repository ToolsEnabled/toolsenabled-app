import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { canonicalRootForTests, discoverCanonicalRoot } from '../canonical-root.mjs'
import { spawnSync } from 'node:child_process'
import { sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { exportedBenchmarkExperiment } from '../../src/research-benchmark-dispatch.js'
import {
  buildExperiment, experimentsSnapshot, parseExperimentsRow, resetExperimentTracking,
  seedExperiments, submitExperimentRuns,
} from '../../src/research-experiments.js'

// Use the same declared App/Engine pair as the other source integration tests.
// No running service or owner account state is read.
// An unconfigured machine is an unconfigured ENVIRONMENT, not a failing
// product. This used to call canonicalRootForTests at module load, which threw,
// so the whole file went red and read as a broken benchmark rather than a
// missing Engine. It now skips each test with a reason that names what is
// absent and how to supply it.
//
// Under TOOLSENABLED_TEST_STRICT it still throws, so CI cannot quietly skip the
// integration coverage: a strict run demands a real Engine or fails loudly.
const strictEngine = process.env.TOOLSENABLED_TEST_STRICT === '1'
const discovered = discoverCanonicalRoot()
const engineRoot = strictEngine || discovered.source !== 'unconfigured'
  ? canonicalRootForTests({ requireConfigured: true })
  : null
const noEngine = engineRoot ? null
  : 'no Engine source is configured on this machine, so this integration suite cannot run. '
    + 'Set MC_CANONICAL_ROOT to an Engine checkout that contains src/lib/agent-org.js, '
    + 'or set TOOLSENABLED_TEST_STRICT=1 to make a missing Engine a failure instead of a skip.'
const require = createRequire(import.meta.url)
const engine = engineRoot ? {
  createStateStore: require(resolve(engineRoot, 'src/lib/state-store.js')).createStateStore,
  ResearchControl: require(resolve(engineRoot, 'src/lib/providers/research.js')).ResearchControl,
  runProcess: require(resolve(engineRoot, 'src/lib/research/runners.js')).runProcess,
  collect: require(resolve(engineRoot, 'src/lib/research/collectors.js')).collect,
  assertProcessReceipt: require(resolve(engineRoot, 'src/lib/research/provenance.js')).assertProcessReceipt,
} : {}
const { createStateStore, ResearchControl, runProcess, collect, assertProcessReceipt } = engine
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))

async function exported(t, spec = genericStarter(), attachments = {}) {
  const scratch = await mkdtemp(resolve(tmpdir(), 'research-benchmark-dispatch-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = resolve(scratch, 'extracted project')
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  const files = await projectFiles(project, sources, attachments)
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, file)), { recursive: true })
    await writeFile(resolve(root, file), text)
  }
  return { root, scratch, project, files }
}

const declaration = fixture => exportedBenchmarkExperiment({ ...fixture,
  directory: fixture.root, command: process.execPath, projectId: 'rp-abcd' })

test('an account or project switch during submission cannot publish stale state or dispatch another cell', async t => {
  if (!engineRoot) return t.skip(noEngine)
  resetExperimentTracking()
  let current = true, writes = 0, submissions = 0
  const built = buildExperiment({ name: 'Context fixture', projectId: 'rp-abcd', axes: [{ id: 'fixture', values: ['first', 'second'] }], runner: { kind: 'process', command: 'node', args: ['fixture.mjs'] }, runsPerCell: 1 }, experimentsSnapshot())
  assert.equal(built.ok, true)
  seedExperiments({ experiments: built.next.experiments, damaged: false })
  try {
    const result = await submitExperimentRuns(built.experiment.id, {
      projectId: 'rp-abcd', isCurrent: () => current, persist: async () => { writes++; return { ok: true } },
      submit: async () => { submissions++; current = false; seedExperiments({ experiments: [], damaged: false }); return { ok: true, run: { runId: 'fixture-run' }, experiment: { experimentId: 'fixture-exp' } } },
    })
    assert.equal(result.ok, false); assert.match(result.sentence, /changed during submission/)
    assert.equal(submissions, 1); assert.equal(writes, 0); assert.deepEqual(experimentsSnapshot().experiments, [])
  } finally { resetExperimentTracking() }
})

test('an existing benchmark cannot be reused to submit work under a different Research project', async t => {
  if (!engineRoot) return t.skip(noEngine)
  resetExperimentTracking()
  const built = buildExperiment({ name: 'Same benchmark', projectId: 'rp-abcd', axes: [{ id: 'fixture', values: ['one'] }], runner: { kind: 'process', command: 'node', args: [] }, runsPerCell: 1 }, experimentsSnapshot())
  assert.equal(built.ok, true); seedExperiments({ experiments: built.next.experiments, damaged: false })
  try {
    const result = await submitExperimentRuns(built.experiment.id, { projectId: 'rp-aaaa', submit: () => assert.fail('wrong project dispatch'), persist: () => assert.fail('wrong project write') })
    assert.equal(result.ok, false); assert.match(result.sentence, /another Research project/)
    assert.equal(experimentsSnapshot().experiments[0].projectId, 'rp-abcd')
  } finally { resetExperimentTracking() }
})

test('service timeout includes startup and finalization and refuses budgets above one hour without changing the export', async t => {
  if (!engineRoot) return t.skip(noEngine)
  const spec = genericStarter()
  spec.protocol.maxDurationMs = 3600000 - 30000
  const boundary = await exported(t, spec)
  const accepted = await declaration(boundary)
  assert.equal(accepted.timeoutMs, 3600000)
  assert.equal(Object.hasOwn(accepted.runner, 'timeoutMs'), false,
    'the engine reads the experiment timeout, not an ignored runner option')

  for (const maxDurationMs of [3570001, 86400000]) {
    spec.protocol.maxDurationMs = maxDurationMs
    const fixture = await exported(t, spec)
    await assert.rejects(declaration(fixture), /one-hour limit.*59 minutes 30 seconds.*exported CLI independently/)
    assert.equal(fixture.project.spec.protocol.maxDurationMs, maxDurationMs)
    const run = spawnSync(process.execPath, [resolve(fixture.root, 'cli.mjs'), 'run', '--project', fixture.root],
      { cwd: fixture.scratch, encoding: 'utf8', timeout: 15000 })
    assert.equal(run.status, 0, run.stderr || run.error?.message)
    assert.equal(JSON.parse(run.stdout).completed, 2,
      'the standalone CLI still accepts the longer declared budget')
  }
})

test('service declarations retain literal paths, all runtime pins and supported adapter environment names', async t => {
  if (!engineRoot) return t.skip(noEngine)
  const spec = genericStarter()
  spec.conditions[0].adapter.env = ['BENCHMARK_TEST_SETTING', 'BENCHMARK_TEST_OTHER', 'BENCHMARK_TEST_SETTING']
  const fixture = await exported(t, spec)
  for (const directory of ['/tmp/benchmark with spaces', 'C:\\Benchmarks\\Study One']) {
    const result = await exportedBenchmarkExperiment({ ...fixture, directory, command: 'node', projectId: 'rp-abcd' })
    assert.deepEqual(result.runner.envKeys, ['BENCHMARK_TEST_OTHER', 'BENCHMARK_TEST_SETTING'])
    assert.equal(result.runner.pinnedFiles.length, RUNTIME_FILES.length + 2)
    assert.deepEqual(result.runner.args.slice(1), ['run', '--project', directory, '--output', '.', '--compact'])
    const separator = directory.startsWith('C:') ? '\\' : '/'
    for (const file of ['manifest.json', 'project.json', ...RUNTIME_FILES]) {
      const pin = result.runner.pinnedFiles.find(pin => pin.path === directory + separator + file)
      assert.ok(pin, `${file} must be pinned before any static import executes`)
      assert.equal(pin.sha256, await sha256(fixture.files[file]))
    }
  }
  for (const directory of ['relative', '/tmp/../study', '/tmp/{benchmark}', 'C:\\Study\\..\\Other']) {
    await assert.rejects(exportedBenchmarkExperiment({ ...fixture, directory, command: 'node', projectId: 'rp-abcd' }))
  }
  await assert.rejects(exportedBenchmarkExperiment({ ...fixture, directory: fixture.root, command: 'node' }), /Choose a saved/)
  const incomplete = { ...fixture.files }
  delete incomplete['module-host.mjs']
  await assert.rejects(declaration({ ...fixture, files: incomplete }), /missing module-host\.mjs/)
})

test('service refuses credential forwarding and oversized declarations with an independent CLI remedy', async t => {
  if (!engineRoot) return t.skip(noEngine)
  const fixture = await exported(t)
  for (const adapter of [
    { kind: 'http', url: 'https://example.invalid', credentialEnv: 'BENCHMARK_TEST_CREDENTIAL' },
    { kind: 'command', command: 'unused', args: [], env: ['BENCHMARK_TEST_SECRET'] },
    { kind: 'command', command: 'unused', args: [], env: Array.from({ length: 17 }, (_, i) => `BENCHMARK_TEST_${i}`) },
  ]) {
    const spec = genericStarter()
    spec.conditions[0].adapter = adapter
    const project = await freezeStudy(await bindRuntimeSources(spec, sources))
    await assert.rejects(declaration({ ...fixture, project }), /run service.*environment variables.*exported CLI independently/i)
  }
  const files = { ...fixture.files, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`custom-${i}.mjs`, '// fixture\n'])) }
  await assert.rejects(declaration({ ...fixture, files }), /64 pinned files.*exported CLI independently/)
})

test('saved declaration registers and deduplicates through the engine, then executes an exported module and collects truthful results', { timeout: 30000 }, async t => {
  if (!engineRoot) return t.skip(noEngine)
  t.diagnostic(`Actual engine runner and collector: ${engineRoot}`)
  const suffix = randomUUID().replaceAll('-', '_').toUpperCase()
  const settingName = `BENCHMARK_TEST_SETTING_${suffix}`
  const ambientName = `BENCHMARK_TEST_SECRET_${suffix}`
  const adapterSource = `export async function run(request) {
    if ('expected' in request || !request.prompt) throw new Error('Invalid blind request');
    if (process.env.${settingName} !== 'fixture-enabled') throw new Error('Missing declared fixture setting');
    if (Object.hasOwn(process.env, '${ambientName}')) throw new Error('Ambient fixture leaked');
    console.error('retained module stderr');
    const numbers = request.prompt.match(/(\\d+) \\+ (\\d+)/);
    return { output: request.trial.taskId === 'addition-b' ? 'intentionally wrong' : String(+numbers[1] + +numbers[2]), usage: { requests: 1 } };
  }\n`
  const spec = genericStarter()
  spec.protocol.maxDurationMs = 1200000
  spec.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs', env: [settingName] }
  spec.inputs = [{ path: 'adapter.mjs', sha256: await sha256(adapterSource) }]
  const fixture = await exported(t, developmentDraft(spec), { 'adapter.mjs': adapterSource })
  const state = createStateStore({ file: resolve(fixture.scratch, 'research.sqlite3') })
  resetExperimentTracking()
  process.env[settingName] = 'fixture-enabled'
  process.env[ambientName] = 'synthetic-noncredential-test-value'
  try {
    state.health()
    const enabled = { state: 'enabled', why: null }
    // Only policy and audit admission are fixtures. Registration, SQLite
    // dedupe, byte verification, native process custody and collection below
    // use the actual engine implementation, without a live worker or provider.
    const control = new ResearchControl({ state,
      gate: () => ({ pipelineWithheld: false, pipeline: enabled, runners: { process: enabled } }),
      auditRequire: () => ({ durable: true }) })
    const { project: serviceProject } = control.projectSave({ actor: 'human', name: 'Synthetic exported benchmark', enabled: true })
    const spec = await exportedBenchmarkExperiment({ ...fixture, directory: fixture.root,
      command: process.execPath, projectId: serviceProject.projectId })
    const built = buildExperiment(spec, { experiments: [] })
    assert.equal(built.ok, true, built.sentence)
    seedExperiments(parseExperimentsRow(built.serialized))
    let receipt, storedRow
    const bodies = []
    const submit = async body => {
      bodies.push(body)
      receipt = control.runSubmit({ actor: 'human', ...body })
      return { ok: true, ...receipt }
    }
    const sent = await submitExperimentRuns(built.experiment.id, { submit, persist: text => { storedRow = text } })
    assert.equal(sent.submitted, 1)
    assert.equal(sent.sentence, null)
    assert.equal(bodies[0].experiment.timeoutMs, 1230000)
    assert.equal(Object.hasOwn(bodies[0].experiment.runnerConfig, 'timeoutMs'), false)
    const stored = state.getResearchExperiment({ experimentId: receipt.experiment.experimentId })
    assert.equal(stored.timeoutMs, 1230000, 'the service must not fall back to its ten-minute default')
    assert.equal(stored.runnerConfig.stdin, 'none')
    assert.deepEqual(stored.runnerConfig.envKeys, [settingName])
    assert.deepEqual(stored.collector, { kind: 'stdout-json', recordKind: 'summary' })
    assert.deepEqual(stored.resultSchema.required, ['answer', 'completed', 'failed', 'scheduled'])
    assert.equal(parseExperimentsRow(storedRow).experiments[0].timeoutMs, 1230000)
    const run = receipt.run
    assert.equal(experimentsSnapshot().experiments[0].cells[0].runId, run.runId)

    const repeated = await submitExperimentRuns(built.experiment.id, { submit })
    assert.equal(repeated.submitted, 0)
    assert.equal(bodies.length, 1, 'already queued local cells are not submitted again')
    seedExperiments(parseExperimentsRow(built.serialized))
    const replayed = await submitExperimentRuns(built.experiment.id, { submit })
    assert.equal(replayed.replayed, 1)
    assert.equal(receipt.run.runId, run.runId, 'a fresh local declaration reuses the service config and params identity')
    assert.equal(state.listResearchRuns({ experimentId: stored.experimentId }).length, 1)

    const artifactDir = resolve(fixture.scratch, 'artifacts')
    await mkdir(artifactDir)
    const outcome = await runProcess({ experiment: stored, run, artifactDir })
    assert.equal(outcome.exitCode, 0, JSON.stringify({ failure: outcome.failure, stderr: outcome.stderr }))
    assert.equal(outcome.failure, null)
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.stdoutTruncated, false)
    assert.equal(outcome.processLifecycle.acceptanceReady, true)
    if (process.platform === 'linux') {
      assert.equal(outcome.processLifecycle.backend, 'linux-subreaper-pidfd-v2')
      assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY')
      assert.ok(outcome.processLifecycle.receipt.observedChildren >= 1, 'the native guardian must observe the CLI root')
      assert.equal(outcome.processLifecycle.receipt.observedChildren, outcome.processLifecycle.receipt.reapedChildren)
    }
    assertProcessReceipt(outcome.provenance, { pins: stored.runnerConfig.pinnedFiles, runId: run.runId, artifactDir })
    assert.ok(!outcome.provenance.invocation.environmentKeys.includes(ambientName))
    assert.ok(outcome.provenance.invocation.environmentKeys.includes(settingName))
    const collected = collect({ collector: stored.collector, resultSchema: stored.resultSchema, stdout: outcome.stdout, artifactDir })
    assert.deepEqual(collected.refused, [])
    assert.equal(collected.dropped, 0)
    assert.equal(collected.records.length, 1)
    const [{ recordKind, record }] = collected.records
    assert.equal(recordKind, 'summary')
    assert.equal(record.answer, '2/2 trials completed')
    assert.equal(record.projectSha256, fixture.project.sha256)
    assert.equal(record.completed, 2)
    assert.equal(record.failed, 0)
    assert.equal(record.scheduled, 2)
    assert.equal(Object.hasOwn(record, 'summary'), false, 'full trial rows remain in the artifact so stdout stays within the collector limit')
    assert.equal(record.evidence, resolve(artifactDir, 'evidence.json'))
    const evidence = JSON.parse(await readFile(resolve(artifactDir, 'evidence.json'), 'utf8'))
    assert.equal(evidence.summary.completed, record.completed)
    assert.equal(evidence.summary.groups[0].passed, 1)
    assert.equal(evidence.summary.groups[0].passRate, 0.5, 'a completed wrong answer must remain a measured failure')
    const completions = evidence.events.filter(event => event.type === 'finished' && event.status === 'completed')
    assert.equal(completions.length, 2)
    for (const event of completions) {
      assert.match(event.response.process.stderr, /retained module stderr/)
      assert.equal(event.response.usage.requests, 1)
    }
    assert.equal(evidence.summary.execution.purpose, 'apparatus-development')
    assert.equal(evidence.summary.execution.experimentalCollection, 'not-admitted')
    // paper/ and trials/ are the complete prompt, layer, request and per-trial response copies the
    // venue-format report writes since 33b92a1d; the list stays exact.
    const expectedArtifacts = ['analysis.json', 'attempts.jsonl', 'conventions.json', 'evidence.json', 'execution-manifest.json', 'execution.json', 'figures', 'paper', 'report.html', 'report.md', 'responses', 'results.csv', 'summary.json', 'tables', 'trials']
    assert.deepEqual((await readdir(artifactDir)).sort(), expectedArtifacts)

    for (const file of ['manifest.json', 'cli.mjs', 'module-host.mjs', 'lean.mjs', 'adapter.mjs']) {
      await writeFile(resolve(fixture.root, file), fixture.files[file] + '\n// changed after export\n')
      let launchReached = false
      await assert.rejects(runProcess({ experiment: stored, run, artifactDir,
        beforeLaunch: () => { launchReached = true } }), { code: 'RESEARCH_PIN_HASH_MISMATCH' })
      assert.equal(launchReached, false, `${file} tampering must be refused before launch admission`)
      await writeFile(resolve(fixture.root, file), fixture.files[file])
    }
    assert.deepEqual((await readdir(artifactDir)).sort(), expectedArtifacts,
      'refused inputs cannot leave new process artifacts')
  } finally {
    delete process.env[settingName]
    delete process.env[ambientName]
    state.close()
    resetExperimentTracking()
  }
})
