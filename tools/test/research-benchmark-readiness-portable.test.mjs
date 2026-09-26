import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { readProject } from '../../src/benchmark/cli.mjs'
import { assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file,
  await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const oneTask = spec => { spec.tasks.length = 1; return spec }
async function exported(t, spec, label, attachments = {}) {
  const base = process.env.READINESS_PORTABLE_EVIDENCE_DIR || tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'readiness-' + label + '-'))
  if (!process.env.READINESS_PORTABLE_EVIDENCE_DIR) t.after(() => rm(root, { recursive: true, force: true }))
  else t.diagnostic('Retained export: ' + root)
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, attachments)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  return { root, project, files }
}
function cli(root, command, ...extra) {
  const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--project', root, ...extra], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}
async function retain(t, name, value) {
  if (!process.env.READINESS_PORTABLE_EVIDENCE_DIR) return
  const path = resolve(process.env.READINESS_PORTABLE_EVIDENCE_DIR, name + '.json')
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, canonical(value) + '\n')
  t.diagnostic('Retained control: ' + path)
}

test('callbacks cannot mutate the frozen answer, grading contract, schedule or source pins after verification', async t => {
  const project = await freezeStudy(oneTask(developmentStarter())), before = structuredClone(project)
  let attempted = 0
  const result = await runStudy(project, { adapter: async ({ project: privateProject, task, condition }) => {
    for (const mutate of [
      () => { task.expected = '999' },
      () => { privateProject.spec.protocol.grading.kind = 'module' },
      () => { privateProject.schedule.length = 0 },
      () => { privateProject.spec.runtimeSources['runner.mjs'] = '0'.repeat(64) },
      () => { condition.adapter.responses[task.id] = '999' },
    ]) { assert.throws(mutate, TypeError); attempted++ }
    return { output: '999' }
  } })
  assert.equal(attempted, 5); assert.deepEqual(project, before)
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.groups[0].passed, 0)
  assert.deepEqual(validateJournal(before, result.events), [])
  await retain(t, 'immutable-project', { project: before, events: result.events, summary: result.summary, rejectedMutations: attempted })
})

test('caller-side edits after invocation cannot change the verified private project snapshot', async () => {
  const project = await freezeStudy(oneTask(developmentStarter())), before = structuredClone(project)
  const result = await runStudy(project, { onEvent: event => {
    if (event.type === 'started') {
      project.tasks[0].expected = '999'; project.spec.tasks[0].expected = '999'
      project.spec.protocol.grading.kind = 'module'
    }
  }, adapter: async () => ({ output: '999' }) })
  assert.equal(project.tasks[0].expected, '999', 'The caller still owns its separate mutable object')
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.groups[0].passed, 0)
  assert.deepEqual(validateJournal(before, result.events), [])
})

test('response persistence and event observers cannot rewrite collected outputs or durable grades', async t => {
  const spec = oneTask(developmentStarter()); spec.protocol.grading.kind = 'json'; spec.tasks[0].expected = { answer: 5 }
  const project = await freezeStudy(spec), transport = { output: { answer: 999 }, usage: { requests: 1 } }, durable = []
  let persisted, rejectedMutations = 0
  const result = await runStudy(project, {
    adapter: async () => transport,
    recordResponse: async row => {
      persisted = structuredClone(row)
      transport.output.answer = 5 // A retained external alias is not the private response.
      assert.throws(() => { row.response.output.answer = 5 }, TypeError); rejectedMutations++
      assert.throws(() => { row.response = { output: { answer: 5 } } }, TypeError); rejectedMutations++
    },
    append: async row => {
      assert.throws(() => { row.seq = 99 }, TypeError); rejectedMutations++
      if (row.type === 'finished') { assert.throws(() => { row.grade.passed = true }, TypeError); rejectedMutations++ }
      durable.push(structuredClone(row))
    },
    onEvent: row => {
      if (row.type === 'finished') {
        assert.throws(() => { row.response.output.answer = 5 }, TypeError); rejectedMutations++
        assert.throws(() => { row.grade.score = 1 }, TypeError); rejectedMutations++
      }
    },
  })
  const finish = result.events.find(row => row.type === 'finished')
  assert.equal(transport.output.answer, 5); assert.equal(persisted.response.output.answer, 999)
  assert.deepEqual(finish.response, persisted.response)
  assert.deepEqual(result.events, durable); assert.equal(rejectedMutations, 7)
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.groups[0].passed, 0)
  assert.deepEqual(validateJournal(project, result.events), [])
  await retain(t, 'immutable-observations', { project, persisted, events: result.events, rejectedMutations })
})

test('direct reports refuse a changed compiled answer even when the edited grade agrees and the original project SHA is retained', async t => {
  const spec = oneTask(developmentStarter()); spec.conditions[0].adapter.responses = { 'addition-a': '999' }
  const project = await freezeStudy(spec), result = await runStudy(project), altered = structuredClone(project), events = structuredClone(result.events)
  altered.tasks[0].expected = '999'; events.find(row => row.type === 'finished').grade = { passed: true, score: 1 }
  assert.equal(altered.sha256, project.sha256)
  await assert.rejects(verifyProject(altered), /frozen project changed/)
  await assert.rejects(researchReportFiles(altered, events), /frozen project changed/)
  const report = await researchReportFiles(project, result.events)
  assert.equal(JSON.parse(report['summary.json']).groups[0].passed, 0)
  await retain(t, 'report-rejects-project-drift', { original: project, originalEvents: result.events, alteredProject: altered, alteredEvents: events })
})

test('caller flags and a schema downgrade cannot turn an unqualified oracle into admitted collection', async () => {
  const seed = oneTask(genericStarter()); seed.tasks[0].expected = '999'; seed.conditions[0].adapter.responses = { 'addition-a': '999' }
  seed.analysisPlan.primaryPopulation = 'all'
  const project = await freezeStudy(await bindRuntimeSources(newExperimentDraft(seed), sources))
  let calls = 0, appends = 0
  await assert.rejects(runStudy(project, { ready: true, canonicalReplay: true, purpose: 'apparatus-development',
    runtime: { readiness: { eligible: true }, capabilities: ['independent-oracle'] },
    adapter: async () => { calls++; return { output: '999' } }, append: async () => { appends++ },
  }), /composition|independent-oracle/)
  assert.equal(calls, 0); assert.equal(appends, 0)
  assert.throws(() => assertCollectionAdmission(project, { operation: 'collect', hostCapabilities: ['independent-oracle'], ready: true }), /unsupported fields/)
  const downgrade = structuredClone(project.spec); downgrade.schemaVersion = 1; delete downgrade.executionPlan
  const legacy = await freezeStudy(downgrade)
  await assert.rejects(runStudy(legacy, { adapter: async () => { calls++; return { output: '999' } } }), /canonical-replay-required/)
  assert.equal(calls, 0)
  const diagnostic = await runStudy(legacy)
  assert.equal(diagnostic.summary.groups[0].passed, 1)
  assert.equal(diagnostic.summary.execution.evidenceClass, 'legacy-evidence')
  assert.equal(diagnostic.summary.execution.experimentalCollection, 'not-admitted')
})

test('standalone readiness and run refuse a wrong authored oracle before any attempt or qualification', async t => {
  const seed = oneTask(genericStarter()); seed.tasks[0].expected = '999'; seed.conditions[0].adapter.responses = { 'addition-a': '999' }
  seed.analysisPlan.primaryPopulation = 'all'
  const { root, project } = await exported(t, newExperimentDraft(seed), 'wrong-oracle')
  const status = cli(root, 'readiness'); assert.equal(status.status, 0, status.stderr)
  const readiness = JSON.parse(status.stdout).readiness
  assert.equal(readiness.collect.eligible, false)
  assert.ok(readiness.collect.blockers.some(row => row.code === 'independent-oracle-required'))
  const flagged = cli(root, 'run', '--ready', 'true')
  assert.equal(flagged.status, 1); assert.match(flagged.stderr, /Unknown option --ready/)
  const result = cli(root, 'run')
  assert.equal(result.status, 1); assert.match(result.stderr, /independent-oracle|composition/)
  assert.equal(await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8'), '')
  await assert.rejects(access(resolve(root, 'results/.run-lock')), { code: 'ENOENT' })
  await retain(t, 'wrong-oracle-cli-refusal', { projectSha256: project.sha256, readiness, stderr: result.stderr })
})

test('rehashed readiness artifacts and a resealed forged project cannot manufacture admission', async t => {
  const seed = oneTask(genericStarter()); seed.analysisPlan.primaryPopulation = 'all'
  const { root, files, project } = await exported(t, newExperimentDraft(seed), 'artifact-forgery')
  for (const file of ['readiness/contract.json', 'readiness/population.json']) {
    const original = JSON.parse(files[file]), forged = file.endsWith('contract.json') ? { ...original, blockers: [] } : { ...original, taskIds: [] }
    const text = canonical(forged) + '\n', manifest = JSON.parse(files['manifest.json'])
    manifest.files[file] = await sha256(text)
    await writeFile(resolve(root, file), text); await writeFile(resolve(root, 'manifest.json'), canonical(manifest) + '\n')
    await assert.rejects(readProject(root), /generated readiness artifact changed/i)
    await writeFile(resolve(root, file), files[file]); delete manifest.files[file]
    await writeFile(resolve(root, 'manifest.json'), canonical(manifest) + '\n')
    await assert.rejects(readProject(root), /manifest omits a generated readiness artifact/i)
    await writeFile(resolve(root, 'manifest.json'), files['manifest.json'])
  }
  const forged = structuredClone(project)
  forged.readiness.blockers = []; forged.readiness.scientificBlockers = []
  const { sha256: ignoredReadiness, ...readinessBody } = forged.readiness
  forged.readiness.sha256 = await sha256(canonical(readinessBody))
  const { sha256: ignoredProject, ...projectBody } = forged
  forged.sha256 = await sha256(canonical(projectBody))
  const projectText = canonical(forged) + '\n', manifest = JSON.parse(files['manifest.json'])
  manifest.projectSha256 = forged.sha256; manifest.files['project.json'] = await sha256(projectText)
  await writeFile(resolve(root, 'project.json'), projectText); await writeFile(resolve(root, 'manifest.json'), canonical(manifest) + '\n')
  await assert.rejects(readProject(root), /frozen project changed/)
  await writeFile(resolve(root, 'project.json'), files['project.json']); await writeFile(resolve(root, 'manifest.json'), files['manifest.json'])
  assert.equal((await readProject(root)).sha256, project.sha256)
})
