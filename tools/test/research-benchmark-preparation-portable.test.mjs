import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { validateJournal } from '../../src/benchmark/runner.mjs'
import { verifyQualificationJournal } from '../../src/benchmark/requirements.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
async function exported(t, role, change = () => {}) {
  const base = process.env.PREPARATION_PORTABLE_EVIDENCE_DIR || tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'preparation-' + role + '-'))
  if (!process.env.PREPARATION_PORTABLE_EVIDENCE_DIR) t.after(() => rm(root, { recursive: true, force: true }))
  else t.diagnostic('Retained preparation export: ' + root)
  const fixture = await genericActivationFixture(); await change(fixture)
  fixture.spec.inputs = await Promise.all(Object.entries(fixture.attachments).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  const project = await freezeStudy(await bindRuntimeSources(fixture.spec, sources)), files = await projectFiles(project, sources, fixture.attachments)
  for (const [file, bytes] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), bytes) }
  return { root, project, attachments: fixture.attachments }
}
function invoke(root, command, extra = []) {
  const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--project', root, ...extra], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}
function success(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) }
async function journal(root) {
  const bytes = await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')
  return { bytes, events: bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
async function preflight(root, intent) {
  const names = await readdir(resolve(root, 'results/preflight'))
  assert.equal(names.length, 1); assert.ok(names[0].startsWith(intent.seq + '-'))
  const directory = resolve(root, 'results/preflight', names[0]), started = JSON.parse(await readFile(resolve(directory, 'started.json'), 'utf8'))
  assert.equal(started.preparationSeq, intent.seq); assert.equal(started.projectSha256, intent.projectSha256)
  return { directory, started }
}
function pair(events, type) {
  const intent = events.find(row => row.type === 'qualification-started'), terminal = events.find(row => row.type === type)
  assert.ok(intent); assert.ok(terminal); assert.equal(terminal.preparationSeq, intent.seq)
  assert.equal(intent.settlementMs, 5000); assert.equal(intent.reservedMs, intent.timeoutMs + 5000)
  assert.ok(Number.isFinite(terminal.elapsedMs) && terminal.elapsedMs >= 0)
  assert.equal(terminal.budgetChargeMs, terminal.elapsedMs)
  return { intent, terminal }
}

test('standalone qualification binds durable preparation and preflight proof, then preserves report bytes on completed resume', async t => {
  const { root, project, attachments } = await exported(t, 'success')
  assert.equal(success(invoke(root, 'run')).completed, 1)
  const before = await journal(root), { intent, terminal } = pair(before.events, 'qualification')
  assert.ok(intent.seq < terminal.seq)
  assert.ok(terminal.seq < before.events.find(row => row.type === 'started').seq)
  assert.equal(terminal.record.moduleExecutions.length, 10)
  const { directory, started } = await preflight(root, intent)
  assert.equal(started.registrySha256, project.requirements.sha256)
  assert.equal(canonical(JSON.parse(await readFile(resolve(directory, 'qualification.json'), 'utf8'))), canonical(terminal.record))
  assert.deepEqual(validateJournal(project, before.events), []); await verifyQualificationJournal(project, before.events)
  const report = await researchReportFiles(project, before.events, await pageReportOptions({ project, sources, attachments }))
  for (const [file, bytes] of Object.entries(report)) assert.ok(await readFile(resolve(root, 'results', file), 'utf8') === bytes, 'Exact preparation report bytes differ: ' + file)
  for (const command of ['status', 'analyze']) assert.equal(success(invoke(root, command)).completed, 1)
  assert.equal(success(invoke(root, 'run')).completed, 1)
  assert.equal((await journal(root)).bytes, before.bytes)
  assert.equal((await readdir(resolve(root, 'results/preflight'))).length, 1)
  for (const [file, bytes] of Object.entries(report)) assert.ok(await readFile(resolve(root, 'results', file), 'utf8') === bytes, 'Report changed after completed resume: ' + file)
  t.diagnostic(RUNTIME_FILES.length + ' source pins; 10 bounded JS interpreter receipts; 1 saved-response trial; ' + Object.keys(report).length + ' exact report files; no work repeated on completed resume.')
})

test('standalone preparation timeout joins the owned interpreter and retains a charged paired failure with partial evidence', async t => {
  const { root, project, attachments } = await exported(t, 'timeout', ({ spec, attachments }) => {
    spec.requirementPlan.selectedInput.timeoutMs = 1000
    spec.protocol.maxDurationMs = 10000
    attachments['interpreters/direct.mjs'] = 'export function interpret() { while (true) {} }\n'
  })
  const outcome = invoke(root, 'run')
  assert.notEqual(outcome.status, 0); assert.match(outcome.stderr, /qualification|time budget/i)
  const { events } = await journal(root), { intent, terminal } = pair(events, 'qualification-failed')
  assert.equal(terminal.status, 'timeout'); assert.ok(terminal.elapsedMs >= intent.timeoutMs)
  assert.equal(events.filter(row => row.type === 'started').length, 0)
  const { directory } = await preflight(root, intent), failure = JSON.parse(await readFile(resolve(directory, 'failure.json'), 'utf8'))
  assert.equal(failure.preparationSeq, intent.seq); assert.equal(failure.projectSha256, project.sha256); assert.equal(failure.cancelled, true)
  assert.equal(failure.partialQualification.moduleExecutions.length, 1)
  const stopped = failure.partialQualification.moduleExecutions[0].process
  assert.equal(stopped.signal, process.platform === 'win32' ? null : 'SIGKILL')
  if (process.platform === 'win32') assert.ok(Number.isInteger(stopped.exitCode) && stopped.exitCode !== 0, 'the terminated Windows interpreter must report a measured failure exit code')
  await assert.rejects(stat(resolve(root, 'results/.run-lock')), { code: 'ENOENT' })
  assert.deepEqual(validateJournal(project, events), []); await verifyQualificationJournal(project, events)
  assert.equal(success(invoke(root, 'status')).completed, 0)
  success(invoke(root, 'analyze'))
  const report = await researchReportFiles(project, events, await pageReportOptions({ project, sources, attachments }))
  for (const [file, bytes] of Object.entries(report)) assert.ok(await readFile(resolve(root, 'results', file), 'utf8') === bytes, 'Failed-preparation report bytes differ: ' + file)
  t.diagnostic('One timed-out JS interpreter closed with retained SIGKILL receipt; charged paired failure persisted before lock release; no candidate dispatched.')
})

test('unresolved CLI preparation returns after bounded join while retaining its lock, then recovery reserves time and permanently halts', async t => {
  const { root, project } = await exported(t, 'unsettled', ({ spec }) => {
    spec.requirementPlan.selectedInput.timeoutMs = 100
    spec.protocol.maxDurationMs = 10000
  })
  const harness = resolve(dirname(root), 'fault-' + root.split(/[\\/]/).at(-1) + '.mjs')
  t.after(() => rm(harness, { force: true }))
  await writeFile(harness, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalWrite = fs.writeFile;
fs.writeFile = async (...args) => {
  await originalWrite(...args);
  if (String(args[0]).startsWith(${JSON.stringify(resolve(root, 'results/preflight') + sep)}) && String(args[0]).endsWith(${JSON.stringify(sep + 'started.json')})) return new Promise(() => {});
};
syncBuiltinESMExports();
try { const { main } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'cli.mjs')).href)}); await main(['run', '--project', ${JSON.stringify(root)}]); }
catch (error) { process.stderr.write(JSON.stringify({ message: error.message, keepLock: error.keepLock, qualificationUnsettled: error.qualificationUnsettled }) + '\\n'); process.exitCode = 1; }
`)
  const started = performance.now(), outcome = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 12000, windowsHide: true })
  assert.equal(outcome.error, undefined, 'The CLI finally block must not await the unresolved qualifier forever.')
  assert.equal(outcome.status, 1)
  const error = JSON.parse(outcome.stderr)
  assert.equal(error.keepLock, true); assert.equal(error.qualificationUnsettled, true)
  assert.ok(performance.now() - started >= 5000, 'The real cleanup grace was not observed.')
  const before = await journal(root), intent = before.events.find(row => row.type === 'qualification-started')
  assert.ok(intent); assert.equal(before.events.length, 1)
  await preflight(root, intent)
  assert.ok((await stat(resolve(root, 'results/.run-lock'))).isDirectory())
  const ordinary = invoke(root, 'run'); assert.notEqual(ordinary.status, 0); assert.match(ordinary.stderr, /locked/)
  const recovered = invoke(root, 'run', ['--recover'])
  assert.notEqual(recovered.status, 0); assert.match(recovered.stderr, /interrupted|unresolved|containment|preparation/i)
  const after = await journal(root), terminal = after.events.find(row => row.type === 'qualification-failed')
  assert.ok(terminal); assert.equal(terminal.preparationSeq, intent.seq); assert.equal(terminal.status, 'interrupted')
  assert.equal(terminal.elapsedMs, null); assert.equal(terminal.budgetChargeMs, intent.reservedMs)
  assert.equal(after.events.filter(row => row.type === 'started').length, 0)
  assert.equal((await readdir(resolve(root, 'results/preflight'))).length, 1)
  assert.ok((await stat(resolve(root, 'results/.run-lock'))).isDirectory())
  await verifyQualificationJournal(project, after.events); validateJournal(project, after.events)
  const repeated = invoke(root, 'run', ['--recover'])
  assert.notEqual(repeated.status, 0); assert.equal((await journal(root)).bytes, after.bytes)
  await writeFile(resolve(root, 'unsettled-recovery-receipt.json'), canonical({ originalError: error, recovery: recovered.stderr, repeatedRecovery: repeated.stderr,
    intent, interrupted: terminal, journalSha256: await sha256(after.bytes), scope: 'Injected unresolved persistence promise, no interpreter child dispatched; real five-second settlement grace.' }) + '\n')
  t.diagnostic('Unresolved persistence used the real 5 s join bound, retained lock and open intent; recovery reserved ' + intent.reservedMs + ' ms and permanently refused collection.')
})
