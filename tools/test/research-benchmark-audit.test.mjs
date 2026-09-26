import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, gradeResponse, prepareStudyReview, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { auditFileBytes, auditFileText, auditStudyFromReference, createAuditReviewRecord, materializeAudit, sealAuditReference, verifyAuditReference } from '../../src/benchmark/audit.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))

test('a judge audit preserves source selection, duplicates and reference labels while producing stable unique cases', async () => {
  const { spec } = await auditFixture(sources), generated = await materializeAudit(spec.auditPlan)
  assert.equal(generated.manifest.sourceTrials, 6)
  assert.equal(generated.tasks.length, 4)
  assert.equal(generated.manifest.ledger.filter(row => row.disposition === 'duplicate-excluded').length, 2)
  assert.equal(generated.tasks.filter(task => task.expected === 'accept').length, 2)
  assert.equal(generated.tasks.filter(task => task.expected === 'reject').length, 2)
  assert.deepEqual(await materializeAudit(spec.auditPlan), generated)
  const project = await freezeStudy(spec)
  await verifyProject(project)
  assert.ok(project.tasks.every(task => task.compiled.text.includes('Judge response format')))
  assert.ok(project.tasks.every(task => !task.compiled.text.includes('sourceGrade') && !task.compiled.text.includes('referenceVerdict')))
  spec.auditPlan.selection = { kind: 'seeded', seed: 885, limit: 2 }
  const sampled = await materializeAudit(spec.auditPlan)
  assert.equal(sampled.manifest.ledger.filter(row => row.disposition === 'sample-excluded').length, 2)
  assert.ok(sampled.tasks.every(task => project.tasks.some(row => row.id === task.id)))
})

test('source edits, absent runtime bytes and forged source grades are refused even when the outer bundle is resealed', async () => {
  const { reference } = await auditFixture(sources)
  const changed = structuredClone(reference); changed.files['runtime/runner.mjs'] += '\n// changed'
  await assert.rejects(verifyAuditReference(changed), /changed after sealing/)
  const { sha256: ignored, ...payload } = changed
  changed.sha256 = await sha256(canonical(payload))
  await assert.rejects(verifyAuditReference(changed), /source runtime changed/)
  const missing = { ...reference.files }; delete missing['runtime/tasks.mjs']
  await assert.rejects(sealAuditReference(reference.project, reference.events, missing), /exactly its pinned/)
  const events = structuredClone(reference.events), completed = events.find(row => row.type === 'finished')
  completed.grade.passed = !completed.grade.passed
  await assert.rejects(sealAuditReference(reference.project, events, reference.files), /recorded grade disagrees/)
})

test('witness-only audits keep outside-set references unscored and freeze eligible denominators before any judge output', async () => {
  const { spec } = await auditFixture(sources)
  spec.auditPlan.criterion.kind = 'admissible-witness'
  spec.tasks = (await materializeAudit(spec.auditPlan)).tasks
  const make = (id, verdict) => ({ ...spec.conditions[0], id, adapter: { kind: 'replay', responses: Object.fromEntries(spec.tasks.map(task => [task.id, { verdict }])) } })
  spec.conditions = [make('accepting', 'accept'), make('rejecting', 'reject'), make('abstaining', 'abstain'), make('malformed', 'not-a-verdict')]
  const project = await freezeStudy(spec), result = await runStudy(project)
  assert.equal(result.summary.completed, 16)
  const group = result.summary.groups.find(row => row.condition === 'accepting')
  assert.equal(group.scheduled, 4); assert.equal(group.measured, 4)
  assert.equal(group.eligibleScheduled, 2); assert.equal(group.eligibleCompleted, 2)
  assert.equal(group.passed, 2); assert.equal(group.scheduledPassRate, 1)
  const unknown = result.summary.rows.filter(row => !row.referenceEligible)
  assert.ok(unknown.every(row => row.passed === null && row.score === null))
  assert.equal(result.summary.audit.groups.find(row => row.condition === 'accepting').falseAcceptances, 0)
  assert.equal(result.summary.audit.groups.find(row => row.condition === 'rejecting').falseRejections, 2)
  const pending = spec.tasks.find(task => task.expected === null)
  assert.equal(gradeResponse(project, project.tasks.find(task => task.id === pending.id), { verdict: 'accept' }).classification, 'reference-unresolved')
  assert.equal(result.events.filter(row => row.type === 'started').length, 16, 'unresolved or malformed completed cases cannot be redrawn')
  const report = await researchReportFiles(project, result.events)
  assert.match(report['report.md'], /Agreement \/ eligible scheduled/)
  assert.match(report['report.md'], /Unresolved references have null scores/)
  assert.equal(JSON.parse(report['audit.json']).groups[0].eligibleScheduled, 2)
  delete spec.analysisPlan.primaryPopulation
  await assert.rejects(freezeStudy(spec), /reference-eligible/)
})

test('audit reviews bind original prompt, reconstruction, candidate, criterion, source evidence and runtime', async () => {
  const { spec } = await auditFixture(sources)
  spec.requireReview = true
  Object.assign(spec, await bindRuntimeSources(spec, sources))
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC AUDIT REVIEW ONLY')))
  const prepared = await prepareStudyReview(spec)
  assert.ok(prepared.tasks.every(task => task.auditPacket.referenceTask.expected !== undefined))
  await assert.rejects(freezeStudy(spec), /complete current judge-audit packet/)
  spec.auditReviews = await Promise.all(prepared.tasks.map(task => createAuditReviewRecord(task, 'SYNTHETIC AUDIT REVIEW ONLY')))
  await freezeStudy(spec)
  const mutated = structuredClone(spec); mutated.tasks[0].expected = 'undetermined'
  await assert.rejects(freezeStudy(mutated), /audit tasks differ/)
  spec.auditPlan.rationale += ' Changed selection justification.'
  spec.tasks = (await materializeAudit(spec.auditPlan)).tasks
  await assert.rejects(freezeStudy(spec), /complete current judge-audit packet/)
})

test('external audits require original source bytes and retain original wording separately from the reconstruction', async () => {
  const { source, events, reference } = await auditFixture(sources), subject = structuredClone(source.spec)
  const inputs = {}
  for (const task of subject.tasks) {
    const path = `external/${task.id}.txt`, original = `Original external wording for ${task.id}; retained verbatim.\n`
    task.provenance = { originalPromptPath: path }; inputs[`inputs/${path}`] = original
    subject.inputs.push({ path, sha256: await sha256(original) })
  }
  const binary = Uint8Array.from([0xff, 0x00, 0x91])
  subject.inputs.push({ path: 'data/blob.bin', sha256: await sha256(binary) })
  inputs['inputs/data/blob.bin'] = { encoding: 'base64', data: Buffer.from(binary).toString('base64') }
  assert.deepEqual(auditFileBytes(inputs['inputs/data/blob.bin']), binary)
  const project = await freezeStudy(subject)
  const retained = events.map(event => ({ ...event, projectSha256: project.sha256,
    ...(event.type === 'started' ? { readinessSha256: project.readiness.sha256, executionPurpose: project.spec.executionPlan.purpose } : {}) }))
  const bundle = await sealAuditReference(project, retained, { ...reference.files, ...inputs })
  const spec = await auditStudyFromReference(bundle)
  spec.auditPlan.provenance = { kind: 'external-benchmark', title: 'SYNTHETIC IMPORT CONTROL', version: 'fixture-1', acquisition: { method: 'Synthetic local fixture', location: 'Test fixture; no external download', at: '2026-09-08T00:00:00Z' }, sourcePaths: ['external/addition-a.txt', 'external/addition-b.txt'] }
  await assert.rejects(materializeAudit(spec.auditPlan), /pinned original prompt/)
  spec.auditPlan.projection.prompt = 'original-prompt-file'
  spec.tasks = (await materializeAudit(spec.auditPlan)).tasks
  const prepared = await prepareStudyReview(spec)
  assert.ok(prepared.tasks.every(task => task.compiled.text.includes('Original external wording')))
  assert.ok(prepared.tasks.every(task => !task.auditPacket.referenceTask.prompt.startsWith('Original external wording')))
  spec.requireReview = false
  await assert.rejects(freezeStudy(spec), /require current personal review/)
})

test('a fresh audit export verifies, qualifies and collects only its public judge projection', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'judge-audit-export-')); t.after(() => rm(directory, { force: true, recursive: true }))
  const { spec } = await auditFixture(sources)
  const adapter = 'let s="";for await(const c of process.stdin)s+=c;const r=JSON.parse(s);if(["expected","audit","reference","sourceGrade","referenceVerdict"].some(k=>k in r)||r.prompt.includes("sourceGrade"))process.exit(4);console.log(JSON.stringify({output:{verdict:"accept"}}));\n'
  spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['judge.mjs'] }
  spec.inputs.push({ path: 'judge.mjs', sha256: await sha256(adapter) })
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, { 'judge.mjs': adapter })
  for (const [file, value] of Object.entries(files)) { const path = resolve(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  for (const command of ['verify', 'qualify', 'run', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr)
  }
  const result = JSON.parse(await readFile(resolve(directory, 'results/summary.json'), 'utf8'))
  assert.equal(result.completed, 4); assert.equal(result.audit.groups[0].falseAcceptances, 2)
  assert.equal(result.audit.groups[0].falseRejections, 0)
  const generated = 'audit/manifest.json', changed = '{}\n', manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'))
  await writeFile(resolve(directory, generated), changed); manifest.files[generated] = await sha256(changed)
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest))
  const tampered = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), 'verify'], { encoding: 'utf8' })
  assert.notEqual(tampered.status, 0); assert.match(tampered.stderr, /Generated audit artifact changed/)
})

test('declared counterexamples establish undetermined labels while finite agreement never establishes uniqueness', async () => {
  for (const count of [1, 2]) {
    const spec = developmentDraft(informationFixture()); spec.tasks[0].information.readings = spec.tasks[0].information.readings.slice(0, count)
    const project = await freezeStudy(await bindRuntimeSources(spec, sources)), result = await runStudy(project)
    const reference = await sealAuditReference(project, result.events, Object.fromEntries(Object.entries(sources).map(([file, text]) => [`runtime/${file}`, text])))
    const draft = await auditStudyFromReference(reference)
    draft.auditPlan.criterion.kind = 'declared-determinacy'
    const cases = await materializeAudit(draft.auditPlan)
    assert.equal(cases.tasks[0].expected, count === 2 ? 'undetermined' : null)
  }
})

test('the source ledger retains ungraded responses and unmeasured trials without inventing candidates', async () => {
  const { source, reference } = await auditFixture(sources)
  const customSource = structuredClone(source.spec), moduleFile = 'fault-grader.mjs'
  const moduleText = 'export function grade(project, task, output) { const passed = output === task.expected; return { passed, score: Number(passed) } }\n'
  customSource.protocol.grading = { kind: 'module', file: moduleFile }
  customSource.inputs.push({ path: moduleFile, sha256: await sha256(moduleText) })
  const customProject = await freezeStudy(customSource)
  let graded = 0
  const result = await runStudy(customProject, { grade: (_project, task, output) => { if (++graded === 2) throw new Error('SYNTHETIC APPARATUS FAILURE'); return gradeResponse(source, task, output) } })
  assert.equal(result.events.find(row => row.status === 'failed').phase, 'grading')
  const bundle = await sealAuditReference(customProject, result.events, { ...reference.files, ['inputs/' + moduleFile]: moduleText }), spec = await auditStudyFromReference(bundle)
  const generated = await materializeAudit(spec.auditPlan), ledger = generated.manifest.ledger
  assert.equal(generated.tasks.length, 1)
  assert.equal(ledger.filter(row => row.disposition === 'source-ungraded-response').length, 1)
  assert.equal(ledger.filter(row => row.disposition === 'source-unmeasured').length, 4)
})

test('CLI reference capture preserves UTF-8 BOMs and binary pinned inputs exactly', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'judge-audit-reference-')); t.after(() => rm(directory, { force: true, recursive: true }))
  const { source } = await auditFixture(sources), spec = structuredClone(source.spec)
  const original = '\uFEFFOriginal task bytes.\r\n', binary = Buffer.from([0xff, 0, 0x91])
  spec.inputs = [{ path: 'original.txt', sha256: await sha256(original) }, { path: 'bytes.bin', sha256: await sha256(binary) }]
  const project = await freezeStudy(spec), files = await projectFiles(project, sources, { 'original.txt': original })
  for (const [file, value] of Object.entries(files)) { const path = resolve(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  await writeFile(resolve(directory, 'bytes.bin'), binary)
  for (const command of ['run', 'reference']) {
    const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr)
  }
  const reference = JSON.parse(await readFile(resolve(directory, 'results/reference-bundle.json'), 'utf8'))
  await verifyAuditReference(reference)
  assert.equal(auditFileText(reference, 'inputs/original.txt'), original)
  assert.deepEqual(Buffer.from(auditFileBytes(reference.files['inputs/bytes.bin'])), binary)
})

test('identical judge inputs cannot silently merge distinct source families or study splits', async () => {
  const { source, reference } = await auditFixture(sources), spec = structuredClone(source.spec)
  spec.tasks[1] = { ...structuredClone(spec.tasks[0]), id: spec.tasks[1].id, familyId: 'different-family', split: 'held-out' }
  spec.catalog.push({ ...structuredClone(spec.catalog[0]), id: 'private-alias', semantics: { ...spec.catalog[0].semantics, privateVariant: 'different' } })
  spec.tasks[1].root.slots.task.use = 'private-alias'
  for (const condition of spec.conditions) condition.adapter.responses[spec.tasks[1].id] = condition.adapter.responses[spec.tasks[0].id]
  const project = await freezeStudy(spec), result = await runStudy(project)
  const bundle = await sealAuditReference(project, result.events, reference.files)
  await assert.rejects(auditStudyFromReference(bundle), /different source families or splits/)
})
