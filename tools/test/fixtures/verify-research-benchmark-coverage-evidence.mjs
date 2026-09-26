// Offline verification of retained evidence. No Python, provider, adapter or
// native engine process is launched; the stored Python process output is read.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { validateJournal } from '../../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../../src/benchmark/report.mjs'
import { simulateTradingMarket } from '../../../src/benchmark/trading-market.mjs'

const json = async file => JSON.parse(await readFile(file, 'utf8'))
export async function verifyCoverageEvidence(directory) {
  const report = await json(resolve(directory, 'qualification.json')), hashes = await json(resolve(directory, 'artifact-hashes.json'))
  assert.equal(report.status, 'qualified'); assert.equal(report.nativeExecutions, 0); assert.equal(report.personalApproval, false); assert.equal(report.countedStudy, false)
  for (const [file, hash] of Object.entries(hashes)) assert.equal(await sha256(await readFile(resolve(directory, file))), hash, file)
  const pins = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await sha256(await readFile(new URL('../../../src/benchmark/' + file, import.meta.url)))])))
  assert.equal(canonical(report.runtimeSources), canonical(pins))
  assert.deepEqual(report.projects.map(row => row.id), ['generic', 'operational'])
  let reportFiles = 0, independentInterpretations = 0, recordedTrials = 0
  for (const row of report.projects) {
    const project = await readProject(resolve(directory, row.id, 'project')), root = resolve(directory, row.id, 'results')
    assert.equal(project.sha256, row.projectSha256); assert.equal(project.corpus.sha256, row.corpusSha256)
    assert.equal(canonical(project.spec.runtimeSources), canonical(pins)); assert.equal(project.corpus.manifest.candidateCount, 8); assert.equal(project.tasks.length, 4)
    assert.ok(project.corpus.manifest.coverage.every(cell => cell.selected >= cell.minimum))
    const pairs = row.id === 'generic' ? [['number', 'wording'], ['number', 'depth'], ['wording', 'depth']] : [['entry', 'quantity'], ['entry', 'operator'], ['quantity', 'operator']]
    assert.equal(canonical(row.pairs), canonical(pairs))
    for (const pair of pairs) assert.equal(new Set(project.tasks.map(task => pair.map(axis => task.factors[axis]).join('/'))).size, 4)
    const events = (await readFile(resolve(root, 'attempts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), evidence = await json(resolve(root, 'evidence.json'))
    assert.equal(canonical(events), canonical(evidence.events)); assert.deepEqual(validateJournal(project, events), [])
    const finished = events.filter(event => event.type === 'finished')
    assert.equal(finished.length, 4); assert.ok(finished.every(event => event.grade.passed)); recordedTrials += finished.length
    const files = await researchReportFiles(project, events)
    for (const [file, bytes] of Object.entries(files)) assert.equal(await readFile(resolve(root, file), 'utf8'), bytes, file)
    reportFiles += Object.keys(files).length
    const qualification = await json(resolve(root, 'qualification.json'))
    assert.equal(qualification.projectSha256, project.sha256)
    if (row.id === 'operational') {
      assert.equal(qualification.checks.length, 4)
      for (const task of project.tasks) {
        const check = qualification.checks.find(check => check.taskId === task.id), result = simulateTradingMarket(task.compiled.operational, task.input)
        assert.equal(check.kind, 'independent-interpretation'); assert.equal(check.passed, true)
        assert.equal(check.python.process.exitCode, 0); assert.equal(check.python.process.stderr, '')
        assert.equal(canonical(JSON.parse(check.python.process.stdout)), canonical(check.python.result))
        assert.equal(canonical(result), canonical(check.javascript)); assert.equal(canonical(result), canonical(check.python.result))
        assert.equal(canonical(task.expected), canonical(result.observation))
        assert.equal(result.observation.orders[0].quantity, Number(task.factors.quantity.slice(2)))
        assert.equal(result.observation.orders[0].time, task.input.bars[0].time); assert.equal(result.observation.orders[0].owner, 'root/child1')
        independentInterpretations++
      }
    }
  }
  assert.equal(independentInterpretations, 4); assert.equal(recordedTrials, 8)
  return { status: 'verified', runtimePins: RUNTIME_FILES.length, retainedFiles: Object.keys(hashes).length, projects: report.projects,
    independentInterpretations, recordedTrials, reportFiles, nativeExecutions: 0 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyCoverageEvidence(resolve(process.argv[2])), null, 2))
