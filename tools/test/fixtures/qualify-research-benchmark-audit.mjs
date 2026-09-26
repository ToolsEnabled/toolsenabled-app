// Actual native source observations followed by deterministic judge controls.
// No external provider collection or investigator approval is represented.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, prepareStudyReview, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { auditStudyFromReference, createAuditReviewRecord, materializeAudit, sealAuditReference, verifyAuditReference } from '../../../src/benchmark/audit.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { qualifyInformation } from './qualify-research-benchmark-information.mjs'

export async function qualifyAudit(directory) {
  const evidence = resolve(directory), sourceDirectory = resolve(evidence, 'source-information')
  await mkdir(evidence, { recursive: true })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const sourceQualification = await qualifyInformation(sourceDirectory)
  const sourceExport = resolve(sourceDirectory, 'exported-project'), sourceResults = resolve(sourceDirectory, 'results')
  const captured = spawnSync(process.execPath, [resolve(sourceExport, 'cli.mjs'), 'reference', '--output', sourceResults], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  await writeFile(resolve(evidence, 'reference.log'), captured.stdout + captured.stderr)
  assert.equal(captured.status, 0, captured.stderr)
  const reference = JSON.parse(await readFile(resolve(sourceResults, 'reference-bundle.json'), 'utf8'))
  await verifyAuditReference(reference)
  const eventsFile = Object.keys(reference.files).find(path => path.endsWith('/order-events.json'))
  assert.ok(eventsFile, 'The source bundle must retain real native order events')
  const events = JSON.parse(reference.files[eventsFile]), filled = events.find(event => String(event.status ?? event.Status).toLowerCase() === 'filled')
  assert.ok(filled)
  filled.fillQuantity = Number(filled.fillQuantity ?? filled.FillQuantity) + 1
  await assert.rejects(sealAuditReference(reference.project, reference.events, { ...reference.files, [eventsFile]: JSON.stringify(events) }), /whole order|trace disagrees/)
  const configFile = Object.keys(reference.files).find(path => path.endsWith('/config.json')), config = JSON.parse(reference.files[configFile])
  config['algorithm-location'] = '/Algorithm/changed.py'
  await assert.rejects(sealAuditReference(reference.project, reference.events, { ...reference.files, [configFile]: JSON.stringify(config) }), /native configuration differs/)
  const judge = `// Synthetic constant-verdict controls; never a real judge result.
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (Object.keys(request).some(key => !['version','projectSha256','trial','attempt','prompt','input','model'].includes(key))) throw new Error('Private reference field entered the judge request');
const verdict = request.model.settings.verdict;
if (verdict === 'transport-failure') { process.stderr.write('Synthetic collection failure'); process.exit(7); }
process.stdout.write(JSON.stringify({ output: { verdict }, usage: null }));
`
  const report = { format: 'judge-audit-native-controls', status: 'passed', countedStudy: false, ownerApproved: false,
    image: sourceQualification.image, nativeSourceExecutions: 9, sourceProjectSha256: reference.project.sha256, referenceSha256: reference.sha256,
    runtimeSources: reference.project.spec.runtimeSources, nativeOrderTamperRefused: true, nativeConfigurationTamperRefused: true, audits: [] }
  for (const criterion of ['frozen-grader', 'admissible-witness', 'declared-determinacy']) {
    let spec = await auditStudyFromReference(reference)
    spec.id = 'native-judge-' + criterion; spec.name = 'Synthetic native judge controls: ' + criterion
    spec.auditPlan.criterion.kind = criterion
    spec.auditPlan.criterion.statement = {
      'frozen-grader': 'Accept a candidate that meets the frozen finite observation criterion and reject one that fails it. This criterion makes no universal correctness claim.',
      'admissible-witness': 'Accept a candidate supported by at least one declared reading. A missing witness does not justify rejection; report undetermined or abstain when the supplied evidence cannot establish a verdict.',
      'declared-determinacy': 'Report undetermined when two admissible readings of the exact visible task have different observable consequences. Finite agreement cannot establish a unique interpretation.',
    }[criterion]
    spec.auditPlan.provenance.kind = 'generated-controls'
    spec.tasks = (await materializeAudit(spec.auditPlan)).tasks
    spec.protocol = { ...spec.protocol, maxAttemptsPerTrial: 1, maxTotalAttempts: 36, timeoutMs: 5000, maxDurationMs: 180000 }
    spec.conditions = ['accept', 'reject', 'undetermined', 'abstain', 'malformed', 'transport-failure'].map(verdict => ({ id: verdict,
      label: 'Synthetic constant-verdict control: ' + verdict, model: { provider: 'fixture', id: 'constant-verdict', settings: { verdict } },
      adapter: { kind: 'command', command: process.execPath, args: ['judge.mjs'] } }))
    spec.inputs = [{ path: 'judge.mjs', sha256: await sha256(judge) }]
    spec = await bindRuntimeSources(spec, sources)
    spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC NATIVE JUDGE BUNDLE ONLY')))
    spec.auditReviews = await Promise.all((await prepareStudyReview(spec)).tasks.map(task => createAuditReviewRecord(task, 'SYNTHETIC NATIVE JUDGE CASE ONLY')))
    const project = await freezeStudy(spec), files = await projectFiles(project, sources, { 'judge.mjs': judge })
    const exported = resolve(evidence, criterion, 'exported-project'), output = resolve(evidence, criterion, 'results')
    for (const [file, contents] of Object.entries(files)) { const path = resolve(exported, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents) }
    for (const command of ['verify', 'qualify', 'run', 'analyze']) {
      console.log(`Running fresh native-source judge audit ${criterion}: ${command}`)
      const result = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), command, '--output', output], { cwd: evidence, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      await writeFile(resolve(evidence, criterion, command + '.log'), result.stdout + result.stderr)
      assert.equal(result.status, command === 'run' ? 2 : 0, result.stderr)
    }
    const summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'))
    assert.equal(summary.scheduled, 36); assert.equal(summary.completed, 30); assert.equal(summary.failed, 6)
    assert.equal(summary.audit.manifest.ledger.filter(row => row.disposition === 'duplicate-excluded').length, 12)
    const accepting = summary.audit.groups.find(row => row.condition === 'accept'), rejecting = summary.audit.groups.find(row => row.condition === 'reject')
    if (criterion === 'frozen-grader') { assert.equal(accepting.falseAcceptances, 4); assert.equal(rejecting.correctRejections, 4); assert.equal(rejecting.falseRejections, 2) }
    if (criterion === 'admissible-witness') {
      assert.equal(accepting.eligibleScheduled, 2); assert.equal(accepting.falseAcceptances, 0); assert.equal(rejecting.falseRejections, 2)
      assert.ok(summary.rows.filter(row => !row.referenceEligible).every(row => row.score === null && row.passed === null))
    }
    if (criterion === 'declared-determinacy') assert.equal(summary.audit.groups.find(row => row.condition === 'undetermined').agreements, 6)
    const retained = await readFile(resolve(output, 'attempts.jsonl'), 'utf8')
    const resumed = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), 'run', '--output', output], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    assert.equal(resumed.status, 2); assert.equal(await readFile(resolve(output, 'attempts.jsonl'), 'utf8'), retained, 'No completed verdict or exhausted collection failure is redrawn')
    report.audits.push({ criterion, projectSha256: project.sha256, cases: project.tasks.length, scheduled: summary.scheduled, completed: summary.completed, failed: summary.failed,
      eligibleCases: project.audit.manifest.referenceEligibleCases, sourceDuplicates: 12, noRedrawVerified: true, privateRequestKeysExcluded: true })
  }
  await writeFile(resolve(evidence, 'qualification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply an evidence directory; this executes local Docker source controls.')
  await qualifyAudit(process.argv[2])
}
