import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { runStudy, replayAdapter, validateJournal } from '../../src/benchmark/runner.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { readProject, runProject } from '../../src/benchmark/cli.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { verifyAuditReference } from '../../src/benchmark/audit.mjs'
import { workflowFixture as legacyWorkflowFixture, workflowEnvelope } from './fixtures/research-benchmark-workflow.mjs'

import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

const workflowFixture = () => developmentDraft(legacyWorkflowFixture())
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
async function exported(t, spec, extra = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'workflow-test-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(extra)) spec.inputs.push({ path, sha256: await sha256(text) })
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, extra)
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), text) }
  return { root, project, files }
}
const ends = events => events.filter(event => event.type === 'finished')
test('workflow routes and terminal projections are frozen before grading; all stages and public requests are retained', async () => {
  const project = await freezeStudy(workflowFixture()), durable = [], requests = []
  const result = await runStudy(project, { append: async event => durable.push(event), adapter: async args => {
    assert.equal(durable.at(-1).type, 'workflow-started'); assert.deepEqual(durable.at(-1).request, args.request)
    requests.push(args.request); return replayAdapter(args)
  } })
  assert.equal(result.summary.completed, 2); assert.equal(result.summary.groups[0].passed, 2); assert.equal(requests.length, 3)
  const revision = requests.find(request => request.workflow.stageId === 'revise'), prompt = JSON.parse(revision.prompt)
  assert.deepEqual(prompt.parents, [{ stageId: 'draft', path: ['answer'], output: '10' }])
  assert.ok(!canonical(revision).includes('DO NOT TRANSFER')); assert.ok(!Object.hasOwn(revision, 'expected')); assert.ok(!Object.hasOwn(revision, 'catalog'))
  assert.equal(revision.collection.instructions.developer, 'Use only the declared parent output and task.')
  assert.equal(result.summary.observations.totals.usage.outputTokens.total, '12')
  assert.equal(result.summary.observations.totals.usage.inputTokens.total, '30')
  assert.equal(result.summary.workflows.stages.filter(stage => stage.selectedForGrade).length, 2)
  assert.deepEqual(validateJournal(project, result.events), [])
  await runStudy(project, { events: result.events, adapter: () => assert.fail('completed workflow must not dispatch again') })
  const report = await researchReportFiles(project, result.events)
  assert.match(report['report.html'], /Frozen prompt workflows/); assert.ok(report['workflows.json']); assert.ok(report['tables/workflow-stage-usage.csv'])
})
test('graph validation rejects cycles, unreachable nodes, missing ancestors, invalid tools and undersized route budgets', async t => {
  for (const [name, alter, pattern] of [
    ['cycle', spec => { spec.workflowPlan.workflows[0].stages[1].next.otherwise = 'draft' }, /acyclic/],
    ['unreachable', spec => { spec.workflowPlan.workflows[0].stages[0].next.otherwise = null }, /reachable/],
    ['ancestor', spec => { spec.workflowPlan.workflows[0].stages[0].parents = [{ stageId: 'revise', path: [] }] }, /ancestor/],
    ['tool', spec => { spec.workflowPlan.workflows[0].stages[1].allowedTools.push('undeclared') }, /declared in the condition/],
    ['calls', spec => { spec.workflowPlan.workflows[0].budgets.maxCalls = 1 }, /longest frozen route/],
    ['unknown', spec => { spec.workflowPlan.workflows[0].stages[0].improvised = true }, /unknown field/],
    ['no-accounting', spec => { delete spec.observationPlan; spec.conditions[0].adapter.mode = 'output' }, /accounting plan/],
  ]) await t.test(name, async () => { const spec = workflowFixture(); alter(spec); await assert.rejects(freezeStudy(spec), pattern) })
})
test('every failure retains its intermediate responses and halts without using retry or later-trial budgets', async t => {
  for (const [name, alter, pattern] of [
    ['tool-denied', response => { response.workflow.toolCalls = [{ id: 'x', name: 'forbidden', arguments: {}, result: 1, status: 'completed' }] }, /allowlist/],
    ['missing-tool-log', response => { delete response.workflow }, /toolCalls/],
    ['identity', response => { response.identity.id = 'different' }, /observation policy/],
    ['incomplete', response => { response.completion.status = 'incomplete' }, /observation policy/],
    ['tokens', response => { response.usage.outputTokens = 21 }, /token budget/],
    ['missing-tokens', response => { delete response.usage.outputTokens }, /token budget/],
  ]) await t.test(name, async () => {
    const spec = workflowFixture(); spec.protocol.maxAttemptsPerTrial = 3
    spec.protocol.grading = { kind: 'module', file: 'workflow-boundary-grader.mjs' }
    spec.inputs.push({ path: 'workflow-boundary-grader.mjs', sha256: await sha256('export function grade() { throw new Error("Invalid stage reached grader") }') })
    const project = await freezeStudy(spec); let calls = 0, grades = 0
    const result = await runStudy(project, { adapter: async args => { calls++; const response = await replayAdapter(args); alter(response); return response }, grade: () => { grades++; assert.fail('invalid stage must not reach grader') } })
    assert.equal(calls, 1); assert.equal(grades, 0); assert.equal(result.summary.completed, 0)
    assert.equal(result.summary.rows.filter(row => row.disposition === 'workflow-halted').length, 1)
    assert.match(result.events.find(event => event.type === 'workflow-finished').reason, pattern)
    assert.ok(ends(result.events)[0].workflow.stages[0].finish.response)
    assert.deepEqual(validateJournal(project, result.events), [])
    await assert.rejects(runStudy(project, { events: result.events, adapter: () => assert.fail('partial workflow redraw') }), /cannot redraw/)
  })
})
test('missing parent projections, byte budgets and terminal result paths never truncate or invent context', async t => {
  for (const [name, change, pattern] of [
    ['parent', spec => { spec.workflowPlan.workflows[0].stages[1].parents[0].path = ['absent'] }, /parent output path/],
    ['request-size', spec => { spec.workflowPlan.workflows[0].budgets.maxRequestBytes = 10 }, /request exceeds/],
    ['response-size', spec => { spec.workflowPlan.workflows[0].budgets.maxResponseBytes = 10 }, /responses exceed/],
    ['result-path', spec => { spec.workflowPlan.workflows[0].stages[1].resultPath = ['missing'] }, /terminal stage result path/],
  ]) await t.test(name, async () => {
    const spec = workflowFixture(); spec.tasks = [spec.tasks[1]]; change(spec)
    const project = await freezeStudy(spec), result = await runStudy(project)
    assert.equal(result.summary.completed, 0); assert.match(ends(result.events)[0].reason, pattern)
    assert.deepEqual(validateJournal(project, result.events), [])
  })
})
test('stage journals reject altered context, branch routes, terminal selection, accounting and duplicate calls', async t => {
  const project = await freezeStudy(workflowFixture()), result = await runStudy(project)
  for (const [name, alter] of [
    ['request', rows => { rows.find(row => row.type === 'workflow-started').request.prompt += ' injected' }],
    ['route', rows => { rows.find(row => row.type === 'workflow-started').stageId = 'revise' }],
    ['selection', rows => { rows.find(row => row.type === 'finished').response.output = 'chosen after scoring' }],
    ['accounting', rows => { rows.find(row => row.type === 'workflow-finished').observations.usage.outputTokens.value++ }],
    ['evidence', rows => { rows.find(row => row.type === 'finished').workflow.stages = [] }],
    ['duplicate', rows => { const index = rows.findIndex(row => row.type === 'workflow-started'); rows.splice(index + 1, 0, structuredClone(rows[index])); rows.forEach((row, i) => { row.seq = i + 1 }) }],
  ]) await t.test(name, () => { const changed = structuredClone(result.events); alter(changed); assert.throws(() => validateJournal(project, changed)) })
})
test('explicit recovery closes an interrupted workflow, retains completed stages and never redispatches', async () => {
  const spec = workflowFixture(); spec.tasks = [spec.tasks[1]]; spec.protocol.maxAttemptsPerTrial = 3
  const project = await freezeStudy(spec), result = await runStudy(project), partial = result.events.slice(0, 4)
  assert.equal(partial.at(-1).type, 'workflow-started')
  await assert.rejects(runStudy(project, { events: partial }), /explicitly recover/)
  const recovered = await runStudy(project, { events: partial, recover: true, adapter: () => assert.fail('uncertain call must not be repeated') })
  const end = ends(recovered.events)[0]
  assert.equal(end.status, 'interrupted'); assert.equal(end.elapsedMs, null); assert.equal(end.budgetChargeMs, spec.protocol.timeoutMs)
  assert.equal(end.workflow.stages.length, 2); assert.equal(end.workflow.stages[1].finish, null)
  assert.equal(recovered.summary.observations.totals.usage.outputTokens.total, null)
  assert.equal(recovered.summary.observations.totals.usage.outputTokens.observedSubtotal, '4')
  assert.deepEqual(validateJournal(project, recovered.events), [])
  await assert.rejects(runStudy(project, { events: recovered.events, recover: true }), /cannot redraw/)
})
test('stage timeout and cancellation retain terminal evidence without waiting for an uncooperative promise', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'cancel' : 'timeout', async () => {
    const spec = workflowFixture(); spec.tasks = [spec.tasks[1]]; spec.workflowPlan.workflows[0].stages[1].timeoutMs = 10
    const project = await freezeStudy(spec), controller = new AbortController(); let calls = 0
    const result = await runStudy(project, { signal: controller.signal, adapter: args => {
      calls++; if (calls === 1) return replayAdapter(args)
      if (cancel) queueMicrotask(() => controller.abort(new Error('SYNTHETIC CANCELLATION')))
      return args.measure.span('transport', () => new Promise(() => {}))
    } })
    assert.equal(calls, 2); assert.equal(ends(result.events)[0].status, cancel ? 'cancelled' : 'failed')
    assert.equal(ends(result.events)[0].workflow.stages[0].finish.response.output.answer, '10')
    assert.deepEqual(validateJournal(project, result.events), [])
  })
})
test('durable stage append failure cannot dispatch or produce a completed attempt', async () => {
  const project = await freezeStudy(workflowFixture()); let calls = 0
  await assert.rejects(runStudy(project, { append: async event => { if (event.type === 'workflow-started') throw new Error('SYNTHETIC DISK FULL') }, adapter: () => { calls++; } }), error => error.keepLock === true)
  assert.equal(calls, 0)
})
test('partial metadata and different currencies keep per-stage subtotals; allocation estimates are charged once per attempt', async t => {
  const spec = workflowFixture(); spec.tasks = [spec.tasks[1]]; spec.workflowPlan.workflows[0].budgets.maxOutputTokens = null
  delete spec.conditions[0].adapter.workflowResponses['addition-b'].revise.usage.outputTokens
  spec.conditions[0].adapter.workflowResponses['addition-b'].revise.usage.cost.currency = 'EUR'
  const allocation = 'SYNTHETIC PER-ATTEMPT ALLOCATION\n'
  spec.observationPlan.costEstimate = { kind: 'per-started-attempt', amount: '0.5', currency: 'USD', rationale: 'Synthetic allocation counted once, not per workflow stage.', sourcePaths: ['allocation.txt'] }
  const { project } = await exported(t, spec, { 'allocation.txt': allocation }), result = await runStudy(project), totals = result.summary.observations.totals
  assert.equal(totals.usage.outputTokens.status, 'partial'); assert.equal(totals.usage.outputTokens.observedSubtotal, '4'); assert.equal(totals.usage.outputTokens.total, null)
  assert.deepEqual(totals.reportedCost.byOrigin[0].byCurrency.map(row => [row.currency, row.total]), [['EUR', '0.03'], ['USD', '0.02']])
  assert.equal(totals.estimatedCost.byOrigin[0].byCurrency[0].total, '0.5')
})
test('workflow artifact bytes and source pins are verified independently by the exported CLI', async t => {
  const { root, project } = await exported(t, workflowFixture()), result = await runProject(root)
  const files = await researchReportFiles(project, result.events, await pageReportOptions({ project, sources }))
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(resolve(root, 'results', name), 'utf8'), text)
  const journal = (await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(await researchReportFiles(project, journal, await pageReportOptions({ project, sources })), files, 'Reports must survive canonical journal serialization, not only an in-memory GUI round trip')
  const reanalyze = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'analyze'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); assert.equal(reanalyze.status, 0, reanalyze.stderr)
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(resolve(root, 'results', name), 'utf8'), text, 'Reanalysis changed ' + name)
  const verified = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'verify'], { encoding: 'utf8' }); assert.equal(verified.status, 0, verified.stderr)
  const reference = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'reference'], { encoding: 'utf8' }); assert.equal(reference.status, 0, reference.stderr)
  const sealed = await verifyAuditReference(JSON.parse(await readFile(resolve(root, 'results/reference-bundle.json'), 'utf8')))
  assert.equal(sealed.events.filter(event => event.type === 'workflow-started').length, 3)
  await writeFile(resolve(root, 'workflows/plan.json'), '{}\n')
  await assert.rejects(readProject(root), /Frozen file changed/)
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
  manifest.files['workflows/plan.json'] = await sha256('{}\n'); await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(readProject(root), /Generated workflow artifact changed/)
  delete manifest.files['workflows/plan.json']; await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(readProject(root), /manifest omits a workflow artifact/)
  const changed = structuredClone(project); changed.spec.workflowPlan.workflows[0].purpose = 'orchestration'
  await assert.rejects(verifyProject(changed), /changed/)
})
test('an incorrect terminal answer is graded once and cannot redraw earlier or later stages', async () => {
  const spec = workflowFixture(); spec.tasks = [spec.tasks[1]]; spec.protocol.maxAttemptsPerTrial = 3
  spec.conditions[0].adapter.workflowResponses['addition-b'].revise.output.answer = 'WRONG TERMINAL ANSWER'
  const project = await freezeStudy(spec), result = await runStudy(project)
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.attempts, 1); assert.equal(result.summary.groups[0].passed, 0)
  assert.equal(result.summary.workflows.stages.length, 2); assert.equal(ends(result.events)[0].response.output, 'WRONG TERMINAL ANSWER')
})
test('exported module transport receives each exact public stage request and preserves its process evidence', async t => {
  const spec = workflowFixture(); spec.conditions[0].adapter = { kind: 'module', file: 'adapters/fixture.mjs' }
  const source = `export async function run(request) {\n if ('expected' in request || 'catalog' in request) throw new Error('private context leak');\n const prompt = JSON.parse(request.prompt), value = request.trial.taskId === 'addition-a' ? '5' : '11';\n return {output: {answer: value, revise: request.trial.taskId === 'addition-b' && request.workflow.stageId === 'draft'}, identity: {provider:'fixture',id:'arithmetic-v1'}, completion: {status:'complete'}, usage:{outputTokens:2}, workflow:{toolCalls:[]}, received:request};\n}\n`
  const { root } = await exported(t, spec, { 'adapters/fixture.mjs': source }), result = await runProject(root)
  assert.equal(result.summary.completed, 2)
  for (const event of result.events.filter(event => event.type === 'workflow-finished')) {
    const start = result.events.find(row => row.type === 'workflow-started' && row.trialId === event.trialId && row.step === event.step)
    assert.deepEqual(event.response.received, start.request); assert.equal(event.response.process.exitCode, 0)
  }
})
test('stage and attempt deadlines kill an actual stalled module host and retain its stderr before releasing ownership', { timeout: 30000 }, async t => {
  for (const limit of ['stage', 'attempt']) await t.test(limit, async t => {
    const spec = workflowFixture(); spec.tasks = [spec.tasks[1]]
    // This proof must reach the real module's busy loop before cancellation.
    // 150 ms included cold Node startup and sometimes killed the child before
    // its PID/stderr marker. Keep both real deadlines, with startup headroom;
    // the separate promise test above still covers a 10 ms stage budget.
    spec.protocol.timeoutMs = limit === 'attempt' ? 4000 : 10000
    spec.workflowPlan.workflows[0].stages.forEach(stage => { stage.timeoutMs = limit === 'stage' && stage.id === 'revise' ? 2000 : spec.protocol.timeoutMs })
    spec.conditions[0].adapter = { kind: 'module', file: 'adapters/stall.mjs' }
    const source = `import {writeSync} from 'node:fs';\nexport async function run(request) {\n if(request.workflow.stageId==='revise'){writeSync(2,'OWNED_WORKFLOW_PID='+process.pid+'\\n');while(true){}}\n return {output:{answer:'draft',revise:true},identity:{provider:'fixture',id:'arithmetic-v1'},completion:{status:'complete'},usage:{outputTokens:1},workflow:{toolCalls:[]}};\n}\n`
    const { root, project } = await exported(t, spec, { 'adapters/stall.mjs': source }), result = await runProject(root)
    assert.equal(result.summary.completed, 0); assert.equal(result.summary.attempts, 1)
    const finish = result.events.find(event => event.type === 'workflow-finished' && event.stageId === 'revise')
    assert.equal(finish.status, 'failed'); assert.match(finish.reason, /time budget exceeded/)
    const pid = Number(finish.response.stderr.match(/OWNED_WORKFLOW_PID=(\d+)/)?.[1]); assert.ok(pid > 0)
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    assert.deepEqual(validateJournal(project, result.events), [])
    await assert.rejects(runProject(root, { recover: true }), /cannot redraw/)
  })
})
