// Standalone compiler/independent-interpreter controls, with retained portable
// projects. This executes no native engine or provider and approves no study.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../../src/benchmark/lean-codegen.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { coverageFixture, operationalCoverageFixture } from './research-benchmark-coverage.mjs'

export async function coverageEvidenceHashes(root, prefix = '') {
  const files = {}
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const file = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) Object.assign(files, await coverageEvidenceHashes(root, file))
    else { assert.ok(entry.isFile()); files[file] = await sha256(await readFile(resolve(root, file))) }
  }
  return files
}
export async function qualifyCoverage(directory) {
  directory = resolve(directory); await mkdir(directory, { recursive: false })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const projects = []
  for (const [id, fixture] of [['generic', coverageFixture], ['operational', operationalCoverageFixture]]) {
    let spec = await bindRuntimeSources(await fixture(), sources)
    if (id === 'operational') {
      spec = await bindLeanReview(spec, sources)
      spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC CORPUS INTERPRETER APPARATUS ONLY')))
    }
    const project = await freezeStudy(spec), root = resolve(directory, id, 'project'), output = resolve(directory, id, 'results')
    assert.equal(project.corpus.manifest.candidateCount, 8); assert.equal(project.tasks.length, 4); assert.equal(project.corpus.manifest.status, 'ready')
    const pairs = id === 'generic' ? [['number', 'wording'], ['number', 'depth'], ['wording', 'depth']] : [['entry', 'quantity'], ['entry', 'operator'], ['quantity', 'operator']]
    for (const pair of pairs) assert.equal(new Set(project.tasks.map(task => pair.map(axis => task.factors[axis]).join('/'))).size, 4)
    if (id === 'operational') for (const task of project.tasks) {
      assert.equal(task.expected.orders[0].quantity, Number(task.factors.quantity.slice(2)))
      assert.equal(task.expected.orders[0].time, task.input.bars[0].time)
      assert.equal(task.expected.orders[0].owner, 'root/child1')
    }
    for (const [file, contents] of Object.entries(await projectFiles(project, sources))) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), contents) }
    for (const command of ['verify', 'qualify', 'run', 'analyze']) {
      const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--output', output], { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
      await writeFile(resolve(directory, id, command + '.json'), JSON.stringify({ exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2) + '\n')
      assert.equal(result.status, 0, result.stderr)
    }
    const qualification = JSON.parse(await readFile(resolve(output, 'qualification.json'), 'utf8')), summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'))
    assert.equal(summary.completed, 4); assert.ok(qualification.checks.every(row => row.passed))
    if (id === 'operational') assert.equal(qualification.checks.filter(row => row.kind === 'independent-interpretation').length, 4)
    projects.push({ id, projectSha256: project.sha256, corpusSha256: project.corpus.sha256, candidateCount: 8, selectedCount: 4, pairs,
      independentInterpretations: qualification.checks.filter(row => row.kind === 'independent-interpretation').length, recordedTrials: summary.completed })
  }
  const hashes = await coverageEvidenceHashes(directory)
  await writeFile(resolve(directory, 'artifact-hashes.json'), JSON.stringify(hashes, null, 2) + '\n')
  const report = { format: 'corpus-coverage-qualification', version: 1, status: 'qualified', runtimeSources: Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([file, bytes]) => [file, await sha256(bytes)]))),
    projects, retainedFiles: Object.keys(hashes).length, nativeExecutions: 0, countedStudy: false, personalApproval: false,
    scope: 'Frozen pair coverage, compiled features, retained standalone verification and report generation; four separately executed Python interpretations agree with JavaScript. No activation, mutant or native qualification gate is cleared.' }
  await writeFile(resolve(directory, 'qualification.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(canonical(await qualifyCoverage(resolve(process.argv[2]))))
