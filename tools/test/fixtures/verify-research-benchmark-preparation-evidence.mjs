#!/usr/bin/env node
// Offline source, lifecycle and retained-evidence verification. This never
// calls a qualifier, candidate adapter, interpreter, child process or provider,
// and never probes the PID recorded in a retained run lock.
import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy, analyze } from '../../../src/benchmark/study.mjs'
import { validateJournal } from '../../../src/benchmark/runner.mjs'
import { verifyQualificationJournal, qualificationPreparationLedger, selectedInputGate, requirementReportFiles } from '../../../src/benchmark/requirements.mjs'
import { researchReportFiles } from '../../../src/benchmark/report.mjs'
import { genericActivationFixture } from './research-benchmark-generic-activation.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const roles = ['success', 'timeout', 'unsettled']
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const same = (actual, expected, label) => assert.ok(canonical(actual) === canonical(expected), label)
async function absent(file) { await assert.rejects(lstat(file), { code: 'ENOENT' }) }
async function fileHashes(directory) {
  const files = {}
  async function walk(folder) {
    for (const name of (await readdir(folder)).sort()) {
      const file = resolve(folder, name), info = await lstat(file)
      assert.equal(info.isSymbolicLink(), false, 'Evidence cannot use symbolic links: ' + file)
      if (info.isDirectory()) await walk(file)
      else {
        assert.ok(info.isFile(), 'Evidence must contain regular files: ' + file)
        files[relative(directory, file).replaceAll('\\', '/')] = await sha256(await readFile(file))
      }
    }
  }
  await walk(directory); return files
}
async function expectedDesign(role, sources) {
  const { spec, attachments } = await genericActivationFixture()
  if (role === 'timeout') {
    spec.requirementPlan.selectedInput.timeoutMs = 1000; spec.protocol.maxDurationMs = 10000
    attachments['interpreters/direct.mjs'] = 'export function interpret() { while (true) {} }\n'
  } else if (role === 'unsettled') {
    spec.requirementPlan.selectedInput.timeoutMs = 100; spec.protocol.maxDurationMs = 10000
  }
  spec.inputs = await Promise.all(Object.entries(attachments).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  // Regenerate the frozen design only. No interpreter or candidate is invoked.
  return freezeStudy(await bindRuntimeSources(spec, sources))
}
function verifyArithmeticProof(record) {
  assert.equal(record.moduleExecutions.length, 10)
  assert.equal(record.checks.length, 1); assert.equal(record.checks[0].kind, 'independent-module-interpretation')
  // Hand-computed outcomes for the selected input, separate probe and wrong
  // first operand. These values are independent of the qualifier implementation.
  const answers = { '2,3,1': '6', '2,3,2': '7', '1,3,1': '5', '1,3,2': '6' }
  const meanings = { reference: [], independent: [] }
  for (const execution of record.moduleExecutions) {
    assert.ok(Object.hasOwn(meanings, execution.kind))
    const { task, target } = execution.request, { a, b } = task.compiled.semantic
    assert.equal(Object.hasOwn(task, 'expected'), false); assert.equal(Object.hasOwn(task.compiled, 'text'), false)
    if (target) same(Object.keys(target), ['requirement'], 'The interpreter received extra private target fields.')
    const expected = answers[[a, b, task.input.offset].join(',')]
    assert.ok(expected, 'The interpreter receipt has an unexpected synthetic input.')
    const raw = JSON.parse(execution.process.stdout)
    same(raw, { output: { observation: expected, activation: { counters: { evaluated: 1 }, transitions: {} } } }, 'Raw counterpart output differs from a hand-computed answer.')
    assert.equal(execution.process.exitCode, 0); assert.equal(execution.process.signal, null)
    assert.equal(typeof execution.process.stderr, 'string')
    meanings[execution.kind].push(expected)
  }
  for (const outcomes of Object.values(meanings)) same(outcomes.sort(), ['5', '6', '6', '6', '7'], 'Counterpart execution roster changed.')
  assert.equal(record.requirements.nativeValidated, false); assert.equal(record.requirements.personalApproval, false)
  assert.equal(record.requirements.selectedInput.compositionStatus, 'qualified')
}
async function verifyOne(directory, role, sources) {
  const project = await readProject(directory)
  same(Object.keys(project.spec.runtimeSources).sort(), [...RUNTIME_FILES].sort(), 'The project needs the exact final runtime source set.')
  for (const file of RUNTIME_FILES) assert.equal(project.spec.runtimeSources[file], await sha256(sources[file]), 'Export has stale runtime source: ' + file)
  assert.equal(project.sha256, (await expectedDesign(role, sources)).sha256, 'Frozen design differs from the exact portable preparation fixture.')
  const journalBytes = await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8')
  assert.ok(journalBytes.endsWith('\n'))
  const events = journalBytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  same(validateJournal(project, events), [], 'The retained trial ledger is unfinished.')
  await verifyQualificationJournal(project, events)
  const intent = events[0], terminal = events[1]
  assert.equal(intent.type, 'qualification-started'); assert.equal(intent.seq, 1)
  assert.equal(terminal.preparationSeq, intent.seq); assert.equal(terminal.seq, 2)
  assert.equal(intent.settlementMs, 5000); assert.equal(intent.reservedMs, intent.timeoutMs + 5000)
  assert.ok(intent.timeoutMs > 0 && intent.timeoutMs <= selectedInputGate(project).timeoutMs)
  const ledger = qualificationPreparationLedger(project, events)
  assert.equal(ledger.preparations, 1); assert.equal(ledger.open, 0); assert.equal(ledger.missingCharge, 0)
  const preflightNames = await readdir(resolve(directory, 'results/preflight'))
  assert.equal(preflightNames.length, 1); assert.ok(preflightNames[0].startsWith(intent.seq + '-'))
  const preflight = resolve(directory, 'results/preflight', preflightNames[0]), started = await json(resolve(preflight, 'started.json'))
  assert.equal(started.preparationSeq, intent.seq); assert.equal(started.projectSha256, project.sha256)
  assert.equal(started.registrySha256, project.requirements.sha256)
  same(started.runtimeSources, project.spec.runtimeSources, 'Preflight source pins changed.')
  same(started.policy, selectedInputGate(project), 'Preflight selected-input policy changed.')
  assert.ok(Number.isFinite(Date.parse(started.startedAt)))
  const result = { role, directory, projectSha256: project.sha256, runtimePins: RUNTIME_FILES.length,
    preparationSeq: intent.seq, status: ledger.rows[0].status, elapsedMs: terminal.elapsedMs, budgetChargeMs: terminal.budgetChargeMs,
    preparationRows: ledger.preparations, retainedInterpreterExecutions: 0, candidateTrials: 0, reportFiles: 0, preflightReportFiles: 0 }
  if (role === 'success') {
    assert.equal(events.length, 4); assert.equal(terminal.type, 'qualification')
    assert.equal(terminal.elapsedMs, terminal.budgetChargeMs); assert.ok(terminal.elapsedMs >= 0)
    assert.equal(ledger.rows[0].chargeBasis, 'measured'); assert.equal(ledger.missingElapsed, 0)
    verifyArithmeticProof(terminal.record)
    const rawProof = await json(resolve(preflight, 'qualification.json'))
    same(rawProof, terminal.record, 'Raw preflight proof differs from the paired journal proof.')
    const preflightReports = requirementReportFiles(rawProof)
    for (const [file, bytes] of Object.entries(preflightReports)) assert.ok(await readFile(resolve(preflight, file), 'utf8') === bytes, 'Raw preflight report bytes differ: ' + file)
    const start = events[2], finish = events[3]
    assert.equal(start.type, 'started'); assert.equal(finish.type, 'finished'); assert.equal(finish.status, 'completed')
    assert.equal(finish.response.output, '6'); assert.equal(finish.grade.passed, true); assert.equal(finish.grade.score, 1)
    const responses = await readdir(resolve(directory, 'results/responses'))
    same(responses, [start.trialId + '-1.json'], 'Durable response roster changed.')
    const response = await json(resolve(directory, 'results/responses', responses[0]))
    same(response, { projectSha256: project.sha256, trialId: start.trialId, attempt: 1, response: finish.response }, 'Durable response differs from the journal.')
    const evidence = await json(resolve(directory, 'results/evidence.json'))
    assert.equal(evidence.projectSha256, project.sha256); same(evidence.events, events, 'Evidence differs from the canonical journal.')
    same(evidence.summary, analyze(project, events), 'Evidence summary differs from journal reanalysis.')
    await absent(resolve(directory, 'results/.run-lock'))
    result.retainedInterpreterExecutions = 10; result.candidateTrials = 1; result.preflightReportFiles = Object.keys(preflightReports).length
  } else if (role === 'timeout') {
    assert.equal(events.length, 2); assert.equal(terminal.type, 'qualification-failed'); assert.equal(terminal.status, 'timeout')
    assert.ok(terminal.elapsedMs >= intent.timeoutMs); assert.equal(terminal.budgetChargeMs, terminal.elapsedMs)
    assert.equal(ledger.rows[0].settled, true); assert.equal(ledger.rows[0].chargeBasis, 'measured')
    const failure = await json(resolve(preflight, 'failure.json'))
    assert.equal(failure.preparationSeq, intent.seq); assert.equal(failure.projectSha256, project.sha256); assert.equal(failure.cancelled, true)
    const partial = failure.partialQualification
    assert.equal(partial.projectSha256, project.sha256); same(partial.runtimeSources, project.spec.runtimeSources, 'Failed qualifier source pins changed.')
    assert.equal(partial.status, 'interrupted-or-failed'); assert.equal(partial.checks.length, 0); assert.equal(partial.moduleExecutions.length, 1)
    const execution = partial.moduleExecutions[0]
    assert.equal(execution.kind, 'reference'); same(execution.binding, project.requirements.interpreters.reference, 'Timed-out interpreter binding changed.')
    assert.equal(execution.process.signal, 'SIGKILL'); assert.equal(typeof execution.process.stdout, 'string'); assert.equal(typeof execution.process.stderr, 'string')
    assert.notEqual(execution.process.exitCode, 0)
    await absent(resolve(preflight, 'qualification.json')); await absent(resolve(directory, 'results/responses')); await absent(resolve(directory, 'results/.run-lock'))
    result.retainedInterpreterExecutions = 1
  } else {
    assert.equal(role, 'unsettled'); assert.equal(events.length, 2)
    assert.equal(terminal.type, 'qualification-failed'); assert.equal(terminal.status, 'interrupted')
    assert.equal(terminal.elapsedMs, null); assert.equal(terminal.budgetChargeMs, intent.reservedMs)
    assert.equal(ledger.rows[0].settled, false); assert.equal(ledger.rows[0].chargeBasis, 'reserved'); assert.equal(ledger.missingElapsed, 1)
    const receipt = await json(resolve(directory, 'unsettled-recovery-receipt.json'))
    same(receipt.intent, intent, 'Recovery receipt changed its preparation intent.'); same(receipt.interrupted, terminal, 'Recovery receipt changed its terminal accounting.')
    assert.equal(receipt.journalSha256, await sha256(journalBytes))
    assert.equal(receipt.originalError.keepLock, true); assert.equal(receipt.originalError.qualificationUnsettled, true)
    assert.match(receipt.originalError.message, /did not settle/); assert.match(receipt.recovery, /termination remains unconfirmed/)
    assert.match(receipt.repeatedRecovery, /cannot resume collection/)
    assert.match(receipt.scope, /Injected unresolved persistence promise, no interpreter child dispatched/)
    const owner = await json(resolve(directory, 'results/.run-lock/owner.json'))
    assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0); assert.match(owner.token, /^[a-f0-9-]{36}$/)
    assert.ok(Number.isFinite(Date.parse(owner.startedAt)))
    await absent(resolve(preflight, 'qualification.json')); await absent(resolve(preflight, 'failure.json')); await absent(resolve(directory, 'results/responses'))
    result.retainedRunLock = true
    result.ownershipScope = 'Retained lock metadata and orphan reservation verified; no process probe or termination inference.'
  }
  if (role !== 'unsettled') {
    const reports = await researchReportFiles(project, events)
    for (const [file, bytes] of Object.entries(reports)) assert.ok(await readFile(resolve(directory, 'results', file), 'utf8') === bytes, 'Exact preparation report bytes differ: ' + file)
    result.reportFiles = Object.keys(reports).length
  }
  const hashes = await fileHashes(directory)
  result.journalSha256 = await sha256(journalBytes); result.retainedFiles = Object.keys(hashes).length
  result.retainedFilesSha256 = await sha256(canonical(hashes))
  return result
}

export async function verifyPreparationEvidence({ evidence, project: selectedProject, root = APP_ROOT } = {}) {
  assert.ok(!(evidence && selectedProject), 'Choose --evidence or --project, not both.')
  assert.equal(RUNTIME_FILES.length, 43, 'This verifier requires the exact 43-file runtime.')
  root = resolve(root); const sources = {}
  for (const file of RUNTIME_FILES) {
    sources[file] = await readFile(resolve(root, 'src/benchmark', file), 'utf8')
    assert.equal(await sha256(sources[file]), await sha256(await readFile(resolve(APP_ROOT, 'src/benchmark', file))), 'The requested root differs from the verifier runtime: ' + file)
  }
  const base = resolve(evidence || resolve(root, '../preparation-portable-final-v2'))
  const directories = selectedProject ? [resolve(selectedProject)] : (await readdir(base, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => resolve(base, row.name)).sort()
  const selectedRoles = directories.map(directory => roles.find(role => directory.split(/[\\/]/).at(-1).startsWith('preparation-' + role + '-')))
  assert.ok(selectedRoles.every(Boolean), 'Evidence contains an unrecognized preparation export.')
  assert.equal(new Set(selectedRoles).size, selectedRoles.length, 'Select one final export per preparation role.')
  if (!selectedProject) same([...selectedRoles].sort(), [...roles].sort(), 'A complete preparation evidence set needs all three exports.')
  const results = []
  for (let index = 0; index < directories.length; index++) results.push(await verifyOne(directories[index], selectedRoles[index], sources))
  const runtimeSources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await sha256(sources[file])])))
  return { status: 'verified', format: 'preparation-portable-offline-verification', version: 1, runtimePins: 43,
    runtimeSources, runtimeSourcesSha256: await sha256(canonical(runtimeSources)), exports: results,
    retainedFiles: results.reduce((sum, row) => sum + row.retainedFiles, 0), reportFiles: results.reduce((sum, row) => sum + row.reportFiles, 0),
    retainedInterpreterExecutions: results.reduce((sum, row) => sum + row.retainedInterpreterExecutions, 0),
    experimentsRun: 0, qualificationRuns: 0, providerCalls: 0, nativeRuns: 0,
    scope: 'Offline final source/artifact bindings, paired preparation accounting, retained independent arithmetic receipts and exact report bytes. This does not repeat the experiments, probe processes, authenticate execution or establish termination of orphan work.' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, args = process.argv.slice(2)
    for (let index = 0; index < args.length; index += 2) {
      assert.ok(['--evidence', '--project', '--root'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--'),
        'Usage: node verify-research-benchmark-preparation-evidence.mjs [--evidence DIRECTORY | --project EXPORT] [--root APP_ROOT]')
      const key = args[index].slice(2); assert.equal(Object.hasOwn(options, key), false, 'Duplicate option: ' + args[index]); options[key] = args[index + 1]
    }
    process.stdout.write(JSON.stringify(await verifyPreparationEvidence(options), null, 2) + '\n')
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
