import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, RUNTIME_FILES, freezeStudy } from '../../src/benchmark/study.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { auditCustomGrades, runProject } from '../../src/benchmark/cli.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const expected = { passed: true, score: 1, classification: 'contained', metrics: { affectedResources: 1, units: 'resources', severity: null }, checks: [true, false] }
const goodGrader = `import { appendFileSync } from 'node:fs';
export function grade() {
  appendFileSync('grader-visits.log', process.pid + '\\n');
  console.error('grading process ' + process.pid);
  return ${JSON.stringify(expected)};
}`
async function exported(t, grader = goodGrader, update = () => {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'benchmark-grade-proof-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const spec = developmentStarter(); spec.tasks.length = 1
  spec.protocol.grading = { kind: 'module', file: 'grader.mjs' }; update(spec)
  spec.inputs.push({ path: 'grader.mjs', sha256: await sha256(grader) })
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  const files = await projectFiles(project, sources, { 'grader.mjs': grader })
  for (const [file, bytes] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), bytes) }
  return { root, project }
}
const completion = events => events.find(event => event.type === 'finished' && event.status === 'completed')
function replaceRetainedResult(event) {
  const { process: receipt, ...grade } = event.grade
  receipt.stdout = canonical({ output: grade }) + '\n'
}

test('complete custom outcomes regrade through fresh bounded processes without changing original execution evidence', async t => {
  const { root, project } = await exported(t)
  const result = await runProject(root), original = structuredClone(result.events)
  const journal = await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')
  const { process: receipt, ...grade } = completion(result.events).grade
  assert.deepEqual(grade, expected)
  assert.deepEqual(JSON.parse(receipt.stdout).output, expected)
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.signal, null)
  await auditCustomGrades(root, project, result.events)
  await auditCustomGrades(root, project, result.events)
  const visits = (await readFile(resolve(root, 'grader-visits.log'), 'utf8')).trim().split('\n')
  assert.equal(visits.length, 3); assert.equal(new Set(visits).size, 3)
  assert.equal(receipt.stderr, 'grading process ' + visits[0] + '\n')
  assert.deepEqual(result.events, original)
  assert.equal(await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8'), journal)
})

test('custom regrading rejects changed, omitted and added scientific fields even with a matching forged original stdout', async t => {
  const { root, project } = await exported(t), result = await runProject(root)
  const mutations = [
    grade => { grade.classification = 'escaped' },
    grade => { grade.metrics.affectedResources = 2 },
    grade => { grade.additionalOutcome = { value: 17, unit: 'files' } },
    grade => { delete grade.classification },
    grade => { delete grade.metrics.severity },
    grade => { grade.metrics.severity = 0 },
    grade => { grade.checks.reverse() },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(result.events), event = completion(changed)
    mutate(event.grade); replaceRetainedResult(event)
    const before = canonical(changed)
    // The portable check verifies the retained receipt, not fresh source execution.
    assert.doesNotThrow(() => validateJournal(project, changed))
    await assert.rejects(auditCustomGrades(root, project, changed), error => {
      assert.match(error.message, /recorded custom grade disagrees with its retained response/)
      assert.deepEqual(error.evidence.output, expected)
      assert.deepEqual(JSON.parse(error.evidence.process.stdout).output, expected)
      return true
    })
    assert.equal(canonical(changed), before)
  }
})

test('portable journal and report checks reject scientific changes that contradict original grader stdout without running a module', async t => {
  const { root, project } = await exported(t), result = await runProject(root)
  await researchReportFiles(project, result.events)
  for (const mutate of [
    grade => { grade.classification = 'escaped' },
    grade => { grade.metrics.affectedResources = 19 },
    grade => { grade.additionalOutcome = 3 },
    grade => { delete grade.metrics },
  ]) {
    const changed = structuredClone(result.events); mutate(completion(changed).grade)
    assert.throws(() => validateJournal(project, changed), /recorded custom grade disagrees with its retained process output/)
    await assert.rejects(researchReportFiles(project, changed), /recorded custom grade disagrees with its retained process output/)
  }
  assert.equal((await readFile(resolve(root, 'grader-visits.log'), 'utf8')).trim().split('\n').length, 1)
})

test('retained custom process output must agree with all scientific fields and certify successful execution', async t => {
  const { root, project } = await exported(t), result = await runProject(root)
  for (const mutate of [
    grade => { grade.classification = 'escaped' },
    grade => { grade.process.stdout = '{not-json' },
    grade => { grade.process.stdout = '{"output":{"passed":true,"score":1}}' },
    grade => { grade.process.exitCode = 1 },
    grade => { grade.process.signal = 'SIGKILL' },
    grade => { delete grade.process.stderr },
  ]) {
    const changed = structuredClone(result.events); mutate(completion(changed).grade)
    await assert.rejects(auditCustomGrades(root, project, changed), /recorded custom grade (disagrees|has no successful process receipt)/)
  }
  assert.equal((await readFile(resolve(root, 'grader-visits.log'), 'utf8')).trim().split('\n').length, 1)
})

test('direct API custom grades without process receipts still require complete canonical output agreement', async t => {
  const { root, project } = await exported(t), result = await runProject(root)
  assert.equal(result.summary.customGrading.withProcessReceipt, 1)
  assert.equal(result.summary.customGrading.withoutProcessReceipt, 0)
  const direct = structuredClone(result.events); delete completion(direct).grade.process
  // JSON object key order is not a scientific change.
  completion(direct).grade = Object.fromEntries(Object.entries(completion(direct).grade).reverse())
  assert.doesNotThrow(() => validateJournal(project, direct))
  const report = await researchReportFiles(project, direct), summary = JSON.parse(report['summary.json'])
  assert.equal(summary.customGrading.withProcessReceipt, 0)
  assert.equal(summary.customGrading.withoutProcessReceipt, 1)
  assert.deepEqual(summary.customGrading.rows, [{ trialId: completion(direct).trialId, attempt: 1, processReceipt: 'unavailable' }])
  assert.equal(summary.groups[0].primaryRate, result.summary.groups[0].primaryRate)
  assert.match(report['tables/custom-grade-evidence.csv'], /"unavailable"/)
  assert.match(report['report.html'], /0 completed grades have retained process receipts; 1 have no process receipt/)
  assert.equal((await readFile(resolve(root, 'grader-visits.log'), 'utf8')).trim().split('\n').length, 1)
  await auditCustomGrades(root, project, direct)
  completion(direct).grade.metrics.extra = false
  await assert.rejects(auditCustomGrades(root, project, direct), /recorded custom grade disagrees/)
  completion(direct).grade.metrics.extra = Number.NaN
  assert.throws(() => validateJournal(project, direct), /Only finite JSON/)
  await assert.rejects(researchReportFiles(project, direct), /Only finite JSON/)
})

test('fresh direct API grades cannot complete an attempt with malformed or contradictory host receipts', async t => {
  const { project } = await exported(t, goodGrader, spec => { spec.protocol.maxAttemptsPerTrial = 2 })
  for (const rejected of [
    { passed: true, score: 1, process: { scientificValue: 7 } },
    { ...expected, process: { stdout: canonical({ output: { passed: true, score: 1 } }) + '\n', stderr: '', exitCode: 0, signal: null } },
    { passed: 'yes', score: 1 },
  ]) {
    let calls = 0
    const result = await runStudy(project, { adapter: async () => { calls++; return { output: 'retained original response' } }, grade: () => structuredClone(rejected) })
    const event = result.events.find(row => row.type === 'finished')
    assert.equal(calls, 1); assert.equal(result.summary.completed, 0)
    assert.equal(event.status, 'failed'); assert.equal(event.phase, 'grading')
    assert.equal(event.response.output, 'retained original response')
    assert.deepEqual(event.gradingEvidence.output, rejected)
    assert.deepEqual(validateJournal(project, result.events), [])
    await assert.rejects(runStudy(project, { events: result.events, grade: () => expected,
      adapter: () => assert.fail('A malformed grade must not redraw the retained response') }), /retained response could not be graded/i)
  }
})

test('classification categories cannot collapse completed trials through object-to-string grouping', async t => {
  const { project } = await exported(t, goodGrader, spec => { spec.tasks = developmentStarter().tasks })
  let calls = 0
  const malformed = await runStudy(project, { grade: (project, task) => {
    calls++; return { passed: true, score: 1, classification: { category: task.id } }
  } })
  assert.equal(calls, 1); assert.equal(malformed.summary.completed, 0); assert.equal(malformed.summary.pending, 1)
  assert.equal(malformed.events.find(row => row.type === 'finished').phase, 'grading')
  assert.ok(!Object.hasOwn(malformed.summary.groups[0].dispositions, '[object Object]'))
  const correct = await runStudy(project, { grade: (project, task) => ({ passed: true, score: 1, classification: task.id }) })
  assert.equal(correct.summary.completed, 2)
  assert.deepEqual(correct.summary.groups[0].dispositions, { 'addition-a': 1, 'addition-b': 1 })
  assert.equal(Object.values(correct.summary.groups[0].dispositions).reduce((sum, count) => sum + count, 0), 2)
  assert.deepEqual(validateJournal(project, correct.events), [])
})

test('custom classification is optional or bounded nonempty text; arbitrary nested metrics remain valid', async t => {
  for (const classification of ['', '   ', false, 0, null, ['contained'], { category: 'contained' }, 'x'.repeat(129)]) {
    const grade = { passed: true, score: 1, classification }, grader = 'export const grade = () => (' + JSON.stringify(grade) + ');'
    const { root } = await exported(t, grader), result = await runProject(root)
    const event = result.events.find(row => row.type === 'finished')
    assert.equal(result.summary.completed, 0)
    assert.equal(event.phase, 'grading'); assert.match(event.reason, /classification/i)
    assert.deepEqual(event.gradingEvidence.output, grade)
  }
  const { project } = await exported(t)
  for (const grade of [
    { passed: true, score: 1, metrics: { impact: { categories: ['contained', null], count: 0 } } },
    { passed: true, score: 1, classification: '  contained  ', metrics: { impact: [true, false, null] } },
  ]) {
    const result = await runStudy(project, { grade: () => structuredClone(grade) })
    assert.equal(result.summary.completed, 1)
    assert.deepEqual(completion(result.events).grade, grade)
    assert.deepEqual(validateJournal(project, result.events), [])
  }
})

test('status, analyze and resume reject classification substitution and retain the exact rejected journal', async t => {
  const { root } = await exported(t), result = await runProject(root)
  const changed = structuredClone(result.events), event = completion(changed)
  event.grade.classification = 'escaped'; replaceRetainedResult(event)
  const journal = resolve(root, 'results/attempts.jsonl'), forged = changed.map(canonical).join('\n') + '\n'
  await writeFile(journal, forged)
  for (const action of ['status', 'analyze', 'run']) {
    const checked = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), action, '--project', root], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    assert.notEqual(checked.status, 0)
    assert.match(checked.stderr, /recorded custom grade disagrees with its retained response/)
    assert.equal(await readFile(journal, 'utf8'), forged)
  }
})

test('module result cannot overwrite the reserved host receipt and its rejected output remains evidence', async t => {
  const grader = 'export function grade() { console.error("reserved-field control"); return { passed:true, score:1, process:{scientificValue:7} } }'
  const { root } = await exported(t, grader), result = await runProject(root)
  const event = result.events.find(event => event.type === 'finished')
  assert.equal(event.status, 'failed'); assert.equal(event.phase, 'grading')
  assert.match(event.reason, /process; that field is reserved/)
  assert.deepEqual(event.gradingEvidence.output.process, { scientificValue: 7 })
  assert.match(event.gradingEvidence.process.stderr, /reserved-field control/)
  assert.equal(event.response.output, '5')
})

test('valid custom-grade booleans and finite scores remain mandatory for both collection and verification', async t => {
  for (const resultValue of [{ passed: 'yes', score: 1 }, { passed: true, score: '1' }, { score: 1 }, null]) {
    const { root, project } = await exported(t, 'export const grade = () => (' + JSON.stringify(resultValue) + ');')
    const result = await runProject(root), event = result.events.find(event => event.type === 'finished')
    assert.equal(event.status, 'failed'); assert.match(event.reason, /custom grader returned no valid result/)
    assert.deepEqual(event.gradingEvidence.output, resultValue)
    const synthetic = [{ type: 'finished', status: 'completed', trialId: project.schedule[0].id, grade: expected, response: { output: '5' } }]
    await assert.rejects(auditCustomGrades(root, project, synthetic), error => {
      assert.match(error.message, /custom grader returned no valid verification result/)
      assert.deepEqual(error.evidence.output, resultValue)
      return true
    })
  }
})

test('contradictory fresh verification results and CPU-blocking verification remain rejected without changing original grades', async t => {
  const { root, project } = await exported(t), result = await runProject(root)
  const original = canonical(result.events)
  // Change only this temporary test module to exercise the verifier's returned
  // value boundary; normal readProject additionally rejects changed source pins.
  await writeFile(resolve(root, 'grader.mjs'), 'export const grade = () => ({ passed:true, score:1, classification:"escaped" });')
  await assert.rejects(auditCustomGrades(root, project, result.events), /recorded custom grade disagrees/)
  await writeFile(resolve(root, 'grader.mjs'), 'export function grade() { console.error("verification hang entered"); for (;;) {} }')
  const bounded = structuredClone(project); bounded.spec.protocol.timeoutMs = 250
  await assert.rejects(auditCustomGrades(root, bounded, result.events), error => {
    assert.match(error.message, /verification timed out/)
    assert.match(error.evidence.stderr, /verification hang entered/)
    assert.equal(error.evidence.signal, process.platform === 'win32' ? null : 'SIGKILL')
    return true
  })
  assert.equal(canonical(result.events), original)
})
