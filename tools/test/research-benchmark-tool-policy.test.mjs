import test from 'node:test'
import assert from 'node:assert/strict'
import { observationPlanFromSpec, observeResponse } from '../../src/benchmark/observations.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { compileRequirementPlan } from '../../src/benchmark/requirements.mjs'
import { sha256 } from '../../src/benchmark/prompts.mjs'
import { deriveReadinessContract, evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'
import { readFile as readFixture } from 'node:fs/promises'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { endpointStudy, FIXED_NOW } from './fixtures/research-benchmark-endpoints.mjs'

// A condition declares its collection controls, including `tools: []` for "no tools".
// validateObservationPlan ends that block with a comment the product has carried all along:
//
//   canonical(condition.collection) // A declaration is not a receipt that the adapter enforced it.
//
// Nothing acted on it. The measured consequence is on the board: at project 5b6ed8d2 the
// claude-cli condition was declared tool-free, the adapter passed a flag that disables
// nothing, and the model wrote and executed a file on the owner's machine during a trial.
// The tool count the adapter reports is already measured (USAGE_FIELDS carries toolCalls);
// it was simply never compared with the declaration, and an absent count read as silence
// rather than as "unknown". See R2/REPORT.md sections 00 and 12.

const plan = observationPlanFromSpec()
const spec = { observationPlan: plan }
const controls = tools => ({ comparisonUnit: 'model', instructions: { system: null, developer: null }, tools,
  contextConstruction: 'fresh public request per attempt', sessionIsolation: 'no shared session between attempts' })
const condition = (collection, kind = 'command') => ({ id: 'model-under-test', model: { provider: 'anthropic', id: 'a-model' }, adapter: { kind }, collection })
const observe = (collection, response, kind) => observeResponse(spec, condition(collection, kind), response)

test('an attempt whose adapter reports tool calls records the applied policy as used, with the count', () => {
  const seen = observe(controls([]), { usage: { toolCalls: 2 } }).toolPolicy
  assert.equal(seen.declared, 'none')
  assert.equal(seen.applied, 'used')
  assert.equal(seen.calls, 2)
  assert.equal(seen.basis, 'adapter-reported')
  assert.equal(seen.agreement, 'violation', 'declared no tools, reported tool use: the two disagree')
})

test('an attempt whose adapter reports zero tool calls records the applied policy as none', () => {
  const seen = observe(controls([]), { usage: { toolCalls: 0 } }).toolPolicy
  assert.equal(seen.declared, 'none'); assert.equal(seen.applied, 'none'); assert.equal(seen.calls, 0)
  assert.equal(seen.agreement, 'match')
})

test('an attempt that reports no tool count at all is unreported, never none', () => {
  for (const response of [{ usage: {} }, { usage: { toolCalls: null } }, {}, undefined]) {
    const seen = observe(controls([]), response).toolPolicy
    assert.equal(seen.applied, 'unreported', 'an absent count is unknown: ' + JSON.stringify(response))
    assert.notEqual(seen.applied, 'none', 'silence must never be recorded as a kept restriction')
    assert.equal(seen.calls, null)
    assert.equal(seen.agreement, 'unverified', 'unverified is not agreement')
  }
})

test('an invalid reported count is unreported, not silently coerced', () => {
  for (const value of [-1, 1.5, '2', true]) {
    const seen = observe(controls([]), { usage: { toolCalls: value } }).toolPolicy
    assert.equal(seen.applied, 'unreported', 'invalid count: ' + JSON.stringify(value))
    assert.equal(seen.calls, null)
  }
})

test('a replay condition dispatched no request, so no tool policy was applied to anything', () => {
  const seen = observe(controls([]), { usage: { toolCalls: 0 } }, 'replay').toolPolicy
  assert.equal(seen.applied, 'no-collection', 'a saved response is not evidence that a live call used no tools')
  assert.equal(seen.agreement, 'not-applicable')
  assert.equal(seen.basis, 'recorded-response')
})

test('a condition declaring no collection controls says so rather than implying a restriction', () => {
  const seen = observe(undefined, { usage: { toolCalls: 3 } }).toolPolicy
  assert.equal(seen.declared, 'not-declared')
  assert.equal(seen.applied, 'used'); assert.equal(seen.calls, 3)
  assert.equal(seen.agreement, 'not-applicable', 'nothing was declared, so nothing is contradicted')
})

test('a condition declaring specific tools records them as a restriction, not as none', () => {
  const seen = observe(controls(['read_file']), { usage: { toolCalls: 1 } }).toolPolicy
  assert.equal(seen.declared, 'restricted')
  assert.deepEqual(seen.declaredTools, ['read_file'])
})

// Recording is not enough: a trial that declared no tools and reports tool use is not a
// measurement of the declared condition, whatever its grade says. R2's own conclusion on the
// two affected claude-cli trials was that neither "stands as a measurement of the declared
// condition"; the apparatus should reach that conclusion by itself.
test('an attempt that reports tool use while declaring none is not an eligible measurement', () => {
  const seen = observe(controls([]), { usage: { toolCalls: 2 } })
  assert.equal(seen.toolPolicy.agreement, 'violation')
  assert.ok(seen.ineligibility.includes('tool-policy-violated'), JSON.stringify(seen.ineligibility))
  assert.equal(seen.eligible, false, 'a contradicted declaration cannot yield an eligible trial')
})

// The other half of the decision, pinned so it cannot drift: silence is NOT a violation.
// Nothing reports toolCalls today, so making an unreported count ineligible would retroactively
// invalidate every existing project including the efaa64a2 run of record. That is a sweeping
// change and not this lane's to make; it is recorded as unverified and left eligible.
test('an unreported tool count leaves the attempt eligible, recorded as unverified', () => {
  const seen = observe(controls([]), { usage: {} })
  assert.equal(seen.toolPolicy.agreement, 'unverified')
  assert.deepEqual(seen.ineligibility, [], 'unknown is not a violation')
  assert.equal(seen.eligible, true)
})

test('a replay condition and an undeclared condition are never marked tool-policy-violated', () => {
  for (const seen of [observe(controls([]), { usage: { toolCalls: 5 } }, 'replay'), observe(undefined, { usage: { toolCalls: 5 } })]) {
    assert.equal(seen.ineligibility.includes('tool-policy-violated'), false, JSON.stringify(seen.toolPolicy))
  }
})

// --- design-time: a restriction the study cannot observe -----------------------------

const httpCondition = {
  id: 'model-under-test', label: 'Model under test',
  model: { provider: 'anthropic', id: 'a-model' },
  adapter: { kind: 'http', url: 'https://example.test/complete' },
  collection: { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [],
    contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' }
}
async function experiment(mutate = () => {}) {
  const spec = (await genericActivationFixture()).spec
  spec.schemaVersion = 2
  spec.executionPlan = { version: 1, purpose: 'experiment', design: { schedule: 'crossed-task-condition', replicates: 'repeated-measurements', primaryOutcome: 'binary-pass', dependence: 'descriptive-only' } }
  spec.analysisPlan.primaryPopulation = 'all'; spec.analysisPlan.primaryDenominator = 'scheduled'
  spec.analysisPlan.uncertainty = null; spec.analysisPlan.multiplicity = 'none-descriptive'
  spec.conditions = [...spec.conditions, structuredClone(httpCondition)]
  spec.observationPlan = observationPlanFromSpec()
  mutate(spec)
  const tasks = await Promise.all(spec.tasks.map(t => compileTask(spec, t, { requireReview: false, requireTaskReview: false })))
  const schedule = tasks.flatMap(t => spec.conditions.flatMap(c => Array.from({ length: spec.protocol.replicates }, (_, i) =>
    ({ id: `${t.id}.${c.id}.${i + 1}`, taskId: t.id, conditionId: c.id, replicate: i + 1 }))))
  const runtimeFiles = ['prompts.mjs', 'readiness.mjs']
  spec.runtimeSources = Object.fromEntries(await Promise.all(runtimeFiles.map(async f => [f, await sha256('static-unit-source:' + f)])))
  const project = { format: 'research-benchmark', version: 2, spec, tasks, schedule, runtimeFiles }
  if (spec.requirementPlan) project.requirements = await compileRequirementPlan(spec, tasks, { requireReview: false })
  project.readiness = await deriveReadinessContract(project)
  return project
}
const collectCodes = project => evaluateReadiness(project, { operation: 'collect' }).blockers.map(row => row.code)

test('a condition declaring no tools whose study maps the adapter tool count is not refused for it', async () => {
  assert.equal(collectCodes(await experiment()).includes('tool-policy-unobservable'), false)
})

test('a declared restriction nothing can ever observe is refused before collection', async () => {
  // The mapping is what turns a declaration into something an attempt can agree or disagree
  // with. Without it the study can only ever repeat its own claim.
  const unmapped = await experiment(spec => { spec.observationPlan.mapping.usage.toolCalls = null })
  assert.ok(collectCodes(unmapped).includes('tool-policy-unobservable'), collectCodes(unmapped).join(', '))
  const noPlan = await experiment(spec => { delete spec.observationPlan })
  assert.ok(collectCodes(noPlan).includes('tool-policy-unobservable'), collectCodes(noPlan).join(', '))
})

test('a per-condition override that unmaps the tool count is refused for that condition', async () => {
  const overridden = await experiment(spec => { spec.observationPlan.overrides = { 'model-under-test': { mapping: { usage: { toolCalls: null } } } } })
  const rows = evaluateReadiness(overridden, { operation: 'collect' }).blockers.filter(row => row.code === 'tool-policy-unobservable')
  assert.equal(rows.length, 1)
  assert.match(rows[0].path, /model-under-test/, 'the refusal names the condition it applies to')
})

test('a replay-only study is never refused for this: it declares no collection controls', async () => {
  const replayOnly = await experiment(spec => { spec.conditions = spec.conditions.filter(c => c.adapter.kind === 'replay'); delete spec.observationPlan })
  assert.equal(collectCodes(replayOnly).includes('tool-policy-unobservable'), false, collectCodes(replayOnly).join(', '))
})

// --- the report says what was applied, not only what was declared --------------------

const endpointsBaseline = JSON.parse(await readFixture(new URL('./fixtures/research-benchmark-endpoints-baseline.json', import.meta.url), 'utf8'))
async function reportFor(mutate = () => {}) {
  const spec = endpointStudy(endpointsBaseline.runtimeSources)
  mutate(spec)
  const project = await freezeStudy(spec)
  const result = await runStudy(project, { now: () => FIXED_NOW })
  return { files: await researchReportFiles(project, result.events), project }
}

test('a study that declares no collection controls gains no tool-policy section, and its report files are unchanged', async () => {
  const { files } = await reportFor()
  assert.deepEqual(Object.keys(files).sort(), Object.keys(endpointsBaseline.files).sort(),
    'a project with nothing to verify must not gain a file')
  assert.doesNotMatch(files['report.md'], /tool policy/i, 'nothing was declared, so there is nothing to check against')
})

test('a condition that declares no tools has its applied policy reported beside the declaration', async () => {
  const { files } = await reportFor(spec => {
    spec.observationPlan = observationPlanFromSpec()
    spec.conditions = spec.conditions.map(condition => ({ ...condition,
      collection: { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [],
        contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' } }))
  })
  const both = files['report.md'] + files['report.html']
  assert.match(files['report.md'], /Declared tool policy and what the attempts applied/,
    'item 5 must state the applied policy, not only the declared one')
  assert.match(both, /no-collection/,
    'these conditions replay saved responses: no request was dispatched, so no policy was applied to anything')
  assert.match(files['report.md'], /A declaration is not a receipt/,
    'the report must say plainly what a declaration is worth')
  // The specification requires this to be additive: existing table ids and CSV columns
  // unchanged. The section above it must still carry exactly its old columns.
  assert.match(files['report.md'], /\| Condition \| Label \| Provider \| Declared model \| Surface \| Adapter \| Target \| Credential variable \| Settings \|/,
    'the existing condition-collection table keeps its exact columns')
  assert.match(files['report.md'], /\| Condition \| Declared \| Applied \| Attempts \| Basis \|/,
    'the applied policy is its own table, not a column bolted onto an existing one')
})

// --- the envelope that was actually sent ---------------------------------------------
// Item 5 asks for "the canonical request envelope actually sent". Retained response files
// carry only { attempt, projectSha256, response, trialId } (Worker 8's measurement, which I
// reproduced), so the report rebuilt the envelope and labelled it a reconstruction. The
// runner never built one at all: it handed the adapter {project, condition, task, trial,
// attempt} and each adapter built its own. cli.mjs already accepts args.request and only
// falls back to building one, so the runner can build it once, send that object and retain it.
test('a dispatching condition retains the exact envelope it sent, and the adapter is given that same envelope', async () => {
  const given = []
  const spec = endpointStudy(endpointsBaseline.runtimeSources)
  spec.conditions = spec.conditions.map(condition => ({ ...condition, adapter: { kind: 'http', url: 'https://example.test/complete' } }))
  const project = await freezeStudy(spec)
  const result = await runStudy(project, { now: () => FIXED_NOW,
    adapter: async args => { given.push(args.request); return { output: args.task.expected } } })
  const started = result.events.filter(row => row.type === 'started')
  assert.ok(started.length > 0)
  assert.ok(started.every(row => row.request), 'every dispatching attempt retains the envelope it sent')
  assert.ok(given.every(Boolean), 'the adapter was handed an envelope rather than left to build its own')
  assert.equal(given.length, started.length)
  assert.deepEqual(started[0].request, given[0], 'the retained envelope is the object that was dispatched, not a second build')
  // The envelope belongs to its own trial's task, not to the first task in the project:
  // the schedule interleaves tasks and conditions.
  const firstTrial = project.schedule.find(row => row.id === started[0].trialId)
  const firstTask = project.tasks.find(row => row.id === firstTrial.taskId)
  assert.equal(started[0].request.prompt, firstTask.compiled.text)
  assert.equal(started[0].request.trial.id, started[0].trialId)
})

test('a replay study dispatches nothing, so it retains no envelope and its journal is byte-unchanged', async () => {
  const project = await freezeStudy(endpointStudy(endpointsBaseline.runtimeSources))
  const result = await runStudy(project, { now: () => FIXED_NOW })
  assert.ok(result.events.filter(row => row.type === 'started').every(row => !row.request),
    'a replayed saved response was never sent anywhere; there is no envelope to retain')
  assert.equal(await sha256(canonical(result.events)), endpointsBaseline.journalSha256,
    'the pinned journal of every existing replay study stays byte-identical')
})

test('item 5 renders the retained envelope as sent, and labels a rebuilt one as a reconstruction', async () => {
  const spec = endpointStudy(endpointsBaseline.runtimeSources)
  spec.conditions = spec.conditions.map(condition => ({ ...condition, adapter: { kind: 'http', url: 'https://example.test/complete' } }))
  const project = await freezeStudy(spec)
  const result = await runStudy(project, { now: () => FIXED_NOW, adapter: async args => ({ output: args.task.expected }) })
  const sent = await researchReportFiles(project, result.events)
  assert.match(sent['report.md'], /retained at dispatch/i, 'a retained envelope is reported as what was sent')
  assert.doesNotMatch(sent['report.md'], /faithful reconstruction/, 'it is not a reconstruction when the bytes were kept')

  // Evidence recorded before this change carries no envelope; the rebuild stays, labelled.
  const older = result.events.map(row => row.type === 'started' ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'request')) : row)
  const rebuilt = await researchReportFiles(project, older)
  assert.match(rebuilt['report.md'], /faithful reconstruction/, 'older evidence keeps the rebuilt form, labelled as such')
})
