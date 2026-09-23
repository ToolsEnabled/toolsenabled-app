import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { workflowEnvelope } from './fixtures/research-benchmark-workflow.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads, sourceLoads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
async function idle(view) {
  for (let index = 0; index < 800; index++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Workflow setup builder did not settle: ' + status(view))
}
function fill(view, name, value) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view)); button.click(); await idle(view)
}
function memoryAccount() {
  const values = new Map(), calls = { reads: 0, writes: 0 }
  return { calls, values, async getSetting(key) { calls.reads++; return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { calls.writes++; values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => { sourceLoads++; return sources },
    download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  // The lightweight stand-in does not implement HTMLInputElement's DOMString
  // conversion. Preserve real browser input semantics for the numeric guard.
  for (const name of ['seed', 'replicates', 'attempts', 'total', 'timeout', 'duration']) {
    const input = field(view, name); let value = String(input.value)
    Object.defineProperty(input, 'value', { configurable: true, get: () => value, set: next => { value = String(next) } })
  }
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
function fixture() {
  const spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  spec.id = 'workflow-setup-controls'; spec.name = 'Workflow setup controls'
  return spec
}
async function prepare(view) {
  const original = fixture()
  fill(view, 'spec-json', JSON.stringify(original)); await click(view, 'apply-spec')
  assert.match(status(view), /Full specification applied/)
  await click(view, 'seed-workflow'); assert.match(status(view), /Workflow draft created/)
  await click(view, 'seed-observations'); assert.match(status(view), /Accounting draft created/)
  const workflow = JSON.parse(field(view, 'workflow-config').value), observation = JSON.parse(field(view, 'observation-plan').value)
  assert.equal(workflow.plan.workflows[0].id, 'prompt-flow')
  assert.deepEqual(workflow.assignments, { recorded: 'prompt-flow' })
  observation.identity.policy = 'require-match'; observation.completion.policy = 'require-complete'
  const conditions = structuredClone(original.conditions)
  conditions[0].adapter = { kind: 'replay', mode: 'envelope', responses: {}, workflowResponses: {
    'addition-a': { answer: workflowEnvelope('5', 2, '0.01') },
    'addition-b': { answer: workflowEnvelope('11', 4, '0.02') },
  } }
  fill(view, 'workflow-config', JSON.stringify(workflow, null, 4))
  fill(view, 'observation-plan', JSON.stringify(observation, null, 4))
  fill(view, 'conditions', JSON.stringify(conditions, null, 4))
  return { original, workflow, observation, conditions }
}
const raw = view => Object.fromEntries(['workflow-config', 'observation-plan', 'conditions', 'inputs', 'environment', 'decisions',
  'seed', 'replicates', 'attempts', 'total', 'timeout', 'duration', 'grading'].map(name => [name, field(view, name).value]))
const state = view => ({ spec: field(view, 'spec-json').value, raw: raw(view), dirty: view.dirty, undo: field(view, 'undo').hidden,
  task: field(view, 'task').value, taskJson: field(view, 'task-json').value, frozen: field(view, 'frozen').textContent,
  results: field(view, 'results').innerHTML, readiness: field(view, 'readiness').innerHTML })
async function joint(view) {
  const loads = sourceLoads, calls = structuredClone(account.calls), count = downloads.length
  const button = field(view, 'apply-workflow-setup'); assert.ok(button); assert.equal(button.disabled, false)
  button.click()
  assert.match(status(view), /^Workflow, protocol and accounting applied together\./, 'The combined operation completes synchronously.')
  assert.equal(sourceLoads, loads); assert.deepEqual(account.calls, calls); assert.equal(downloads.length, count)
  await idle(view)
  assert.equal(sourceLoads, loads); assert.deepEqual(account.calls, calls)
}

beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  account = memoryAccount(); downloads = []; sourceLoads = 0
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('seeded workflow and accounting apply with explicit replay envelopes as one valid setup, freeze and retain two recorded stage results', async () => {
  const view = await mount(), prepared = await prepare(view), before = state(view)
  assert.deepEqual((await draft(view)).pending.sort(), ['observations', 'protocol', 'workflow'])
  await click(view, 'apply-protocol')
  assert.equal(status(view), 'Recorded envelopes require a frozen observation plan that declares their metadata mappings.')
  assert.deepEqual(state(view), before)
  await click(view, 'apply-workflow')
  assert.equal(status(view), 'Apply the current protocol, observations edits first. Your text is preserved.')
  assert.deepEqual(state(view), before)
  await click(view, 'apply-observations')
  assert.equal(status(view), 'Apply the current protocol edits first. Your text is preserved.')
  assert.deepEqual(state(view), before)

  await joint(view)
  const applied = specOf(view)
  assert.deepEqual(applied.workflowPlan, prepared.workflow.plan)
  assert.deepEqual(applied.observationPlan, prepared.observation)
  assert.deepEqual(applied.conditions[0].adapter, prepared.conditions[0].adapter)
  assert.equal(applied.conditions[0].workflowId, 'prompt-flow')
  assert.deepEqual(applied.tasks, prepared.original.tasks)
  assert.deepEqual(applied.analysisPlan, prepared.original.analysisPlan)
  assert.equal(applied.executionPlan.purpose, 'recorded-diagnostic')
  assert.equal(applied.reviews?.length || 0, 0); assert.equal(applied.requirementPlan, undefined)
  assert.deepEqual((await draft(view)).pending, [])
  await click(view, 'freeze')
  assert.match(field(view, 'frozen').textContent, /^2 tasks · 2 scheduled trials · SHA-256 [a-f0-9]{64}$/)
  assert.equal(field(view, 'run').disabled, false)
  await click(view, 'run'); assert.match(status(view), /Recorded-response run finished/)
  await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  assert.equal(evidence.summary.completed, 2); assert.equal(evidence.summary.groups[0].passed, 2)
  const starts = evidence.events.filter(event => event.type === 'workflow-started')
  const finishes = evidence.events.filter(event => event.type === 'workflow-finished')
  assert.equal(starts.length, 2); assert.equal(finishes.length, 2)
  assert.ok(finishes.every(event => event.status === 'completed'))
  assert.deepEqual(finishes.map(event => event.response.output).sort(), ['11', '5'])
})

test('successful joint Apply saves the valid applied setup and Undo restores all three preceding raw editor groups and selection', async () => {
  const view = await mount(), prepared = await prepare(view)
  field(view, 'task').value = '1'; field(view, 'task').dispatch('change'); await idle(view)
  const previousRaw = raw(view), previous = await draft(view)
  await joint(view); await click(view, 'save')
  assert.equal(view.dirty, false)
  const savedSpec = specOf(view), savedBytes = canonical([...account.values]), cold = await mount()
  assert.deepEqual(specOf(cold), savedSpec)
  assert.deepEqual((await draft(cold)).pending, [])
  assert.equal(field(cold, 'undo').hidden, true)
  assert.equal(specOf(cold).conditions[0].workflowId, 'prompt-flow')
  await click(view, 'undo')
  assert.deepEqual(specOf(view), prepared.original)
  assert.deepEqual(raw(view), previousRaw)
  assert.deepEqual((await draft(view)).pending, previous.pending)
  assert.equal(field(view, 'task').value, '1')
  assert.equal(canonical([...account.values]), savedBytes, 'Undo does not silently replace the saved applied setup.')
  await joint(view)
  assert.deepEqual(specOf(view), savedSpec)
})

test('invalid accounting, workflow, protocol or stage maps preserve action-entry state and the preceding Undo target', async () => {
  for (const [corrupt, error] of [
    [view => fill(view, 'observation-plan', '{ unfinished accounting'), /Accounting plan must be valid JSON/],
    [view => { const plan = JSON.parse(field(view, 'observation-plan').value); plan.completion.policy = 'invented'; fill(view, 'observation-plan', JSON.stringify(plan)) }, /Record reported generation completion/],
    [view => { const workflow = JSON.parse(field(view, 'workflow-config').value); workflow.plan.workflows[0].stages[0].timeoutMs = 60001; fill(view, 'workflow-config', JSON.stringify(workflow)) }, /A stage timeout must fit within the attempt timeout/],
    [view => fill(view, 'timeout', 'unfinished seconds'), /Enter a finite number for Attempt timeout/],
    [view => fill(view, 'seed', '   '), /Enter a finite number for Schedule seed/],
    [view => { const conditions = JSON.parse(field(view, 'conditions').value); conditions[0].adapter.mode = 'output'; fill(view, 'conditions', JSON.stringify(conditions)) }, /Workflow replay needs envelope mode/],
    [view => { const conditions = JSON.parse(field(view, 'conditions').value); conditions[0].adapter.workflowResponses['addition-a'] = { 'unknown-stage': workflowEnvelope('5') }; fill(view, 'conditions', JSON.stringify(conditions)) }, /Recorded workflow responses must name stages in the selected workflow/],
  ]) {
    const view = await mount(), undoTarget = (await draft(view)).spec
    await prepare(view); corrupt(view)
    const before = state(view), pending = (await draft(view)).pending, calls = structuredClone(account.calls), loads = sourceLoads
    await click(view, 'apply-workflow-setup')
    assert.match(status(view), error)
    assert.deepEqual(state(view), before)
    assert.equal(sourceLoads, loads); assert.deepEqual(account.calls, calls)
    assert.deepEqual((await draft(view)).pending, pending)
    await click(view, 'undo')
    const undone = await draft(view)
    assert.deepEqual(undone.spec, undoTarget, 'A failed setup must not replace the existing full-spec Undo target.')
    assert.ok(undone.pending.includes('specification'), 'Undo also restores the previous unapplied full-spec editor buffer.')
    assert.deepEqual(specOf(view), fixture())
  }
})

test('joint validation resolves assignments and accounting overrides against the newly edited condition roster', async () => {
  const view = await mount(), prepared = await prepare(view)
  const conditions = ['new-a', 'new-b'].map(id => ({ ...structuredClone(prepared.conditions[0]), id, label: id }))
  fill(view, 'conditions', JSON.stringify(conditions))
  const before = state(view)
  await click(view, 'apply-workflow-setup')
  assert.match(status(view), /Assign each current condition/)
  assert.deepEqual(state(view), before)
  const workflow = structuredClone(prepared.workflow); workflow.assignments = { 'new-a': 'prompt-flow', 'new-b': 'prompt-flow' }
  fill(view, 'workflow-config', JSON.stringify(workflow))
  const observation = structuredClone(prepared.observation); observation.overrides.recorded = { completion: { policy: 'record' } }
  fill(view, 'observation-plan', JSON.stringify(observation))
  await click(view, 'apply-workflow-setup')
  assert.match(status(view), /overrides must name existing conditions/)
  assert.deepEqual(specOf(view).conditions, prepared.original.conditions)
  delete observation.overrides.recorded; observation.overrides['new-b'] = { completion: { policy: 'require-complete' } }
  fill(view, 'observation-plan', JSON.stringify(observation))
  await joint(view)
  assert.deepEqual(specOf(view).conditions.map(condition => [condition.id, condition.workflowId]), [['new-a', 'prompt-flow'], ['new-b', 'prompt-flow']])
  assert.deepEqual(specOf(view).observationPlan.overrides, observation.overrides)
  await click(view, 'freeze')
  assert.match(field(view, 'frozen').textContent, /^2 tasks · 4 scheduled trials · SHA-256 [a-f0-9]{64}$/)
})

test('workflow removal requires explicit null assignments and removal of stale replay maps and envelope mode', async () => {
  const view = await mount(), prepared = await prepare(view); await joint(view)
  const applied = structuredClone(specOf(view))
  fill(view, 'workflow-config', JSON.stringify({ plan: null, assignments: { recorded: 'prompt-flow' } }))
  fill(view, 'observation-plan', 'null')
  await click(view, 'apply-workflow-setup')
  assert.match(status(view), /workflow needs a frozen workflow plan/)
  assert.deepEqual(specOf(view), applied)
  fill(view, 'workflow-config', JSON.stringify({ plan: null, assignments: { recorded: null } }))
  const stale = state(view)
  await click(view, 'apply-workflow-setup')
  assert.match(status(view), /Recorded workflow responses require|Recorded envelopes require/)
  assert.deepEqual(state(view), stale)
  const explicit = structuredClone(prepared.conditions)
  delete explicit[0].adapter.workflowResponses; delete explicit[0].adapter.mode
  explicit[0].adapter.responses = structuredClone(prepared.original.conditions[0].adapter.responses)
  fill(view, 'conditions', JSON.stringify(explicit))
  await joint(view)
  assert.equal(specOf(view).workflowPlan, undefined); assert.equal(specOf(view).observationPlan, undefined)
  assert.equal(Object.hasOwn(specOf(view).conditions[0], 'workflowId'), false)
  assert.equal(Object.hasOwn(specOf(view).conditions[0].adapter, 'workflowResponses'), false)
  assert.deepEqual(specOf(view).conditions[0].adapter, prepared.original.conditions[0].adapter)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, false)
})

test('unrelated pending editors refuse joint Apply and pending setup is isolated by project and account', async () => {
  const view = await mount(); await prepare(view); await click(view, 'save')
  const retained = raw(view), pending = (await draft(view)).pending
  for (const [editor, group] of [['task-json', 'task'], ['input', 'input'], ['corpus-plan', 'corpus'], ['analysis-rationale', 'analysis']]) {
    const other = await mount(); fill(other, editor, 'unfinished ' + group)
    const before = state(other), calls = structuredClone(account.calls), loads = sourceLoads
    await click(other, 'apply-workflow-setup')
    assert.equal(status(other), `Apply the current ${group} edits first. Your text is preserved.`)
    assert.deepEqual(state(other), before)
    assert.equal(field(other, editor).value, 'unfinished ' + group)
    assert.equal(sourceLoads, loads); assert.deepEqual(account.calls, calls)
  }
  await view.setContext(B, 'live'); await idle(view)
  assert.equal(specOf(view).id, 'my-benchmark')
  assert.equal(field(view, 'observation-plan').value, 'null')
  assert.equal(JSON.parse(field(view, 'workflow-config').value).plan, null)
  const isolated = await mount({ account: memoryAccount() })
  assert.equal(specOf(isolated).id, 'my-benchmark')
  assert.equal(specOf(isolated).workflowPlan, undefined)
  await view.setContext(A, 'live'); await idle(view)
  assert.deepEqual(raw(view), retained)
  assert.deepEqual((await draft(view)).pending, pending)
  await joint(view)
  assert.equal(specOf(view).id, 'workflow-setup-controls')
  assert.equal(specOf(view).workflowPlan.workflows[0].id, 'prompt-flow')
})
