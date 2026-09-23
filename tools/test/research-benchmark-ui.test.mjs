import { useArithmeticExample } from './lib/benchmark-example.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { approveBundle, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { createBenchmarkStore } from '../../src/research-benchmark-store.js'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'
import { operationalRequirementFixture } from './fixtures/research-benchmark-requirements.mjs'
import { workflowFixture } from './fixtures/research-benchmark-workflow.mjs'
import { verifyAuditReference } from '../../src/benchmark/audit.mjs'
import { registerBenchmark, registeredBenchmarks, resetRegistry } from '../../src/benchmark/registry.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36)
const views = [], gates = []
let installed, fixture, cryptoDescriptor
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause() }
  assert.fail('the benchmark UI did not settle')
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  const gate = { promise, resolve }; gates.push(gate); return gate
}
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const node = (view, name, path = '') => view.el.querySelectorAll(`[data-node-${name}]`).find(input => input.getAttribute(`data-node-${name}`) === path)
const message = view => f(view, 'status').textContent
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
function fill(view, name, value) { const input = f(view, name); assert.equal(input.disabled, false); input.value = value; input.dispatch('input') }
async function click(view, name) { assert.equal(f(view, name).disabled, false, `${name} is available`); f(view, name).click(); await idle(view) }
async function choose(view, name, value) { f(view, name).value = value; f(view, name).dispatch('change'); await idle(view) }
async function recordedDiagnostic(view) { fill(view, 'execution-purpose', 'recorded-diagnostic'); await click(view, 'apply-execution') }
async function wrap(view, path = '') { node(view, 'wrapper', path).value = 'context'; node(view, 'wrap', path).click(); await idle(view) }
async function mount(options = {}) {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources, download: (name, contents) => fixture.downloads.push({ name, contents }), ...options })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live')
  await useArithmeticExample(view, { examples: true })
  await until(() => f(view, 'preview-meta').textContent.includes('components') && f(view, 'review-status').textContent.includes('SHA-256'))
  return view
}
async function importDraft(view, data) {
  const contents = JSON.stringify(data)
  f(view, 'import').files = [{ size: contents.length, text: async () => contents }]
  f(view, 'import').dispatch('change'); await idle(view)
}
beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fixture = { values: new Map(), reads: [], writes: [], downloads: [], get: null, put: null }
  fixture.account = {
    async getSetting(key) { fixture.reads.push(key); if (fixture.get) await fixture.get(key); return { ok: true, value: fixture.values.get(key) ?? null } },
    async putSetting(key, value) { fixture.writes.push({ key, value }); if (fixture.put) await fixture.put(key, value); fixture.values.set(key, value); return { ok: true } },
  }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  for (const gate of gates.splice(0)) gate.resolve()
  await pause()
  installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('snippet names and labels persist through account save and remount, including unapplied edits', async () => {
  const view = await mount()
  await click(view, 'add-atom')
  fill(view, 'bundle-title', 'Reason to buy')
  fill(view, 'bundle-labels', 'Entry, Price condition')
  fill(view, 'wording', 'Act when the measured price is below the threshold.')
  await click(view, 'apply-bundle')
  await click(view, 'save')
  const restored = await mount()
  assert.equal(f(restored, 'bundle-title').value, 'Reason to buy')
  assert.equal(f(restored, 'bundle-labels').value, 'Entry, Price condition')
  fill(restored, 'bundle-labels', 'Entry, Intraday')
  await click(restored, 'save')
  const pending = await mount()
  assert.equal(f(pending, 'bundle-labels').value, 'Entry, Intraday')
  assert.match(f(pending, 'snippet-label-preview').textContent, /Intraday/)
  await click(pending, 'export-snippets')
  assert.match(message(pending), /Apply the current snippet/)
})

// One round trip a person actually performs: write a snippet, give it a label
// in their own words, then find it again by that label and by its wording.
/* PROMPT B: the shipped library now carries the owner's own labels, two of
   which are "Reason to buy". These two tests are about a label a PERSON
   types, so they use one the library does not already hold; otherwise they
   were asserting that the example set stays out of their way, which is a
   different and much weaker claim. */
test('a snippet created with a label is found again by that label and by searching its text', async () => {
  const view = await mount()
  const cards = () => view.el.querySelectorAll('[data-bench-select-snippet]')
  const titles = () => cards().map(card => card.querySelector('strong').textContent)
  const starting = cards().length
  await click(view, 'add-atom')
  fill(view, 'bundle-title', 'My own snippet')
  fill(view, 'bundle-labels', 'my own label, Entry')
  fill(view, 'wording', 'Buy when the measured spread narrows below the stated threshold.')
  await click(view, 'apply-bundle')
  assert.equal(cards().length, starting + 1, 'the new snippet joins the library')
  const options = f(view, 'snippet-label-filter').querySelectorAll('option').map(option => option.getAttribute('value'))
  assert.equal(options.includes('label:my own label'), true, 'the label the person typed is offered for filtering')
  await choose(view, 'snippet-label-filter', 'label:my own label')
  assert.deepEqual(titles(), ['My own snippet'], 'filtering by that label selects exactly the snippet given it')
  await choose(view, 'snippet-label-filter', '')
  fill(view, 'snippet-search', 'spread narrows')
  assert.deepEqual(titles(), ['My own snippet'], 'searching its wording finds the same snippet')
  fill(view, 'snippet-search', 'My own snippet')
  assert.deepEqual(titles(), ['My own snippet'], 'searching its name finds it too')
  fill(view, 'snippet-search', 'a phrase no snippet contains')
  assert.equal(cards().length, 0)
  assert.match(f(view, 'snippet-list').textContent, /No matching snippets/)
})

// Categories are the owner's organising idea, so they have to be visible and
// pressable, not only reachable through a dropdown a person must think to open.
//
// Each press is awaited: pressing a category re-renders the category strip
// itself, and the DOM stand-in does not deliver a delegated click to a node
// that replaced its predecessor during the same dispatch. A real browser does
// -- verified by driving these same presses on the running page -- so the wait
// accommodates the harness without weakening what is asserted.
test('every category in the library is shown with its count and filters the list when pressed', async () => {
  const view = await mount()
  const chip = name => view.el.querySelectorAll('[data-bench-snippet-category]').find(item => item.getAttribute('data-bench-snippet-category') === name)
  const titles = () => view.el.querySelectorAll('[data-bench-select-snippet]').map(card => card.querySelector('strong').textContent)
  const press = async name => { chip(name).click(); await pause() }
  const starting = titles().length
  // The starting library is no longer entirely uncategorised, so the count on
  // the "without a category" chip is read from the library itself rather than
  // assumed to be the whole of it.
  await press('unlabelled')
  const startingWithoutCategory = titles().length
  await press('')

  await click(view, 'add-atom')
  fill(view, 'bundle-title', 'Reason to buy')
  fill(view, 'bundle-labels', 'my own label, Entry')
  fill(view, 'wording', 'Buy when the measured spread narrows below the stated threshold.')
  await click(view, 'apply-bundle')
  await click(view, 'add-atom')
  fill(view, 'bundle-title', 'How to buy')
  fill(view, 'bundle-labels', 'Entry')
  fill(view, 'wording', 'Place the order at the stated limit.')
  await click(view, 'apply-bundle')

  assert.match(chip('label:Entry').textContent, /Entry\s*2/, 'a category shows how many snippets are in it')
  assert.match(chip('label:my own label').textContent, /my own label\s*1/)
  assert.match(chip('').textContent, new RegExp(`All\s*${starting + 2}`), 'All counts the whole library')
  assert.match(chip('unlabelled').textContent, new RegExp(`category\s*${startingWithoutCategory}`), 'snippets with no category stay reachable')

  await press('label:Entry')
  assert.deepEqual(titles().sort(), ['How to buy', 'Reason to buy'], 'pressing a category filters the library to it')
  assert.equal(chip('label:Entry').getAttribute('aria-pressed'), 'true', 'the pressed category is marked')
  assert.equal(chip('').getAttribute('aria-pressed'), 'false')

  await press('label:my own label')
  assert.deepEqual(titles(), ['Reason to buy'], 'a snippet carrying two categories is found under each of them')

  await press('unlabelled')
  assert.equal(titles().includes('Reason to buy'), false, 'a labelled snippet is not "without a category"')

  await press('')
  assert.equal(titles().length, starting + 2, 'All restores the whole library')
  assert.equal(chip('').getAttribute('aria-pressed'), 'true')
})

test('snippet search leaves a saved draft unchanged, and local exports retain account guards in example mode', async () => {
  const view = await mount()
  await click(view, 'save')
  assert.equal(view.dirty, false)
  fill(view, 'snippet-search', 'task')
  assert.equal(view.dirty, false)
  const writesBeforePreview = fixture.writes.length
  await view.setContext(A, 'mock')
  await useArithmeticExample(view, { examples: true })
  await click(view, 'export-snippets')
  assert.equal(JSON.parse(fixture.downloads.at(-1).contents).format, 'benchmark-snippet-library')
  assert.equal(fixture.writes.length, writesBeforePreview)
  assert.equal(f(view, 'save').disabled, true)
  assert.match(f(view, 'save').title, /Connect your account to save here/)
  assert.equal(fixture.writes.length, writesBeforePreview)
  await click(view, 'draft-export')
  assert.match(message(view), /Draft exported, including unapplied editor text\./)
  assert.match(fixture.downloads.at(-1).name, /-draft\.json$/)
  assert.ok(JSON.parse(fixture.downloads.at(-1).contents).spec)
  assert.equal(fixture.writes.length, writesBeforePreview)
})

test('draft loading locks editors and a superseded load cannot replace the selected project', async () => {
  await createBenchmarkStore(fixture.account).save(A, { spec: { ...genericStarter(), name: 'Saved A' } })
  const gate = deferred()
  fixture.get = key => key === `research_benchmark_${A}` ? gate.promise : undefined
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources })
  views.push(view); document.body.append(view.el)
  const old = view.setContext(A, 'live')
  assert.equal(f(view, 'name').disabled, true)
  await view.setContext(B, 'live')
  fill(view, 'name', 'Current B')
  gate.resolve(); await old
  assert.equal(f(view, 'name').value, 'Current B')
  assert.equal(view.dirty, true)
  assert.doesNotMatch(message(view), /Saved A|changed while/)
})

test('requirement authoring preserves pending edits and binds exact targets without claiming execution', async () => {
  const view = await mount(), spec = await operationalRequirementFixture(), plan = spec.requirementPlan
  delete spec.requirementPlan
  await importDraft(view, { spec })
  fill(view, 'requirement-plan', JSON.stringify(plan))
  await click(view, 'freeze')
  assert.match(message(view), /Apply.*requirement|unapplied.*requirement/i)
  await click(view, 'apply-requirements')
  assert.match(message(view), /exact bindings/)
  await click(view, 'prepare-requirements')
  const packet = JSON.parse(f(view, 'requirement-registry').textContent)
  assert.equal(packet.targets.length, 5); assert.ok(packet.unregistered.length > 0)
  assert.equal(packet.runtimeSources['requirements.mjs'], await sha256(sources['requirements.mjs']))
  assert.match(message(view), /does not execute qualification/)
  await click(view, 'freeze')
  assert.match(message(view), /needs review/)
  const confounded = structuredClone(plan)
  confounded.targets[0].wrongReadings[0].root.slots.buy_process.params.quantity = 2
  fill(view, 'requirement-plan', JSON.stringify(confounded))
  await click(view, 'apply-requirements')
  assert.match(message(view), /unrelated requirement/)
  assert.equal(f(view, 'requirement-plan').value, JSON.stringify(confounded))
})

test('workflow authoring applies plan and assignments together, preserves project drafts and blocks pending or invalid routes', async () => {
  const view = await mount(), spec = workflowFixture(), config = { plan: spec.workflowPlan, assignments: { recorded: 'revise' } }
  delete spec.workflowPlan; delete spec.conditions[0].workflowId
  await importDraft(view, { spec })
  fill(view, 'workflow-config', JSON.stringify(config)); await click(view, 'freeze')
  assert.match(message(view), /Apply.*workflow|unapplied.*workflow/i)
  await click(view, 'save'); await view.setContext(B, 'live')
  assert.equal(JSON.parse(f(view, 'workflow-config').value).plan, null)
  await view.setContext(A, 'live'); assert.equal(JSON.parse(f(view, 'workflow-config').value).plan.workflows[0].id, 'revise')
  await click(view, 'apply-workflow'); assert.match(message(view), /Workflow applied/)
  await click(view, 'freeze'); assert.equal(f(view, 'run').disabled, false)
  await click(view, 'run'); assert.match(f(view, 'results').textContent, /2 of 2 trials completed/)
  const invalid = structuredClone(config); invalid.plan.workflows[0].stages[1].next.otherwise = 'draft'
  fill(view, 'workflow-config', JSON.stringify(invalid)); await click(view, 'apply-workflow')
  assert.match(message(view), /acyclic/); assert.equal(f(view, 'workflow-config').value, JSON.stringify(invalid))
  fill(view, 'workflow-config', JSON.stringify({ plan: null, assignments: { recorded: null } })); await click(view, 'apply-workflow')
  assert.match(message(view), /removed/)
})

test('a project switch stops the remaining save writes and retains the new project’s dirty state', async () => {
  const view = await mount(), gate = deferred()
  fill(view, 'name', 'Save A')
  fixture.put = () => gate.promise
  f(view, 'save').click()
  await until(() => fixture.writes.length === 1)
  assert.equal(f(view, 'name').disabled, true)
  await view.setContext(B, 'live')
  fill(view, 'name', 'Unsaved B')
  gate.resolve(); await pause()
  assert.equal(f(view, 'name').value, 'Unsaved B')
  assert.equal(view.dirty, true)
  assert.equal(fixture.writes.length, 1)
  assert.equal(fixture.values.has(`research_benchmark_${A}`), false)
  assert.doesNotMatch(message(view), /Draft saved/)
})

for (const action of ['use-starter', 'freeze']) test(`a delayed ${action} cannot overwrite a newer project or release its operation lock`, async () => {
  const first = deferred(), second = deferred()
  let calls = 0
  const view = await mount({ loadSources: () => ++calls === 1 ? first.promise : second.promise })
  if (action === 'use-starter') f(view, 'starter').value = 'lean-bench'
  f(view, action).click()
  assert.equal(f(view, 'name').disabled, true)
  await view.setContext(B, 'live')
  await useArithmeticExample(view)
  fill(view, 'name', 'Keep B')
  f(view, 'freeze').click()
  first.resolve(sources); await pause()
  assert.equal(f(view, 'name').value, 'Keep B')
  assert.equal(f(view, 'name').disabled, true)
  assert.equal(f(view, 'export').disabled, true)
  second.resolve(sources); await idle(view)
  assert.equal(f(view, 'name').value, 'Keep B')
  assert.equal(f(view, 'run').disabled, true)
  assert.match(f(view, 'readiness').textContent, /interpreter|qualification/)
})

test('a delayed synthetic review cannot approve a bundle in another project', async () => {
  const view = await mount(), gate = deferred()
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async (...args) => { await gate.promise; return webcrypto.subtle.digest(...args) } } } })
  f(view, 'reviewer').value = 'SYNTHETIC UI TEST ONLY'
  f(view, 'approve').click()
  await view.setContext(B, 'live')
  gate.resolve(); await pause(); await pause()
  await click(view, 'draft-export')
  assert.deepEqual(JSON.parse(fixture.downloads.at(-1).contents).spec.catalog, [])
  assert.equal(f(view, 'review-status').textContent, '')
  assert.equal(f(view, 'reviewer').value, '')
  assert.doesNotMatch(message(view), /Your review was recorded/)
})

test('an older dependency digest cannot overwrite a newly recorded review status', async () => {
  const view = await mount(), gate = deferred()
  let digests = 0
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async (...args) => {
    if (++digests === 1) await gate.promise
    return webcrypto.subtle.digest(...args)
  } } } })
  f(view, 'reviewer').value = 'SYNTHETIC REVIEW RACE ONLY'
  await click(view, 'approve')
  await until(() => f(view, 'review-status').textContent.startsWith('Reviewed by SYNTHETIC REVIEW RACE ONLY'))
  gate.resolve(); await pause(); await pause()
  assert.match(f(view, 'review-status').textContent, /^Reviewed by SYNTHETIC REVIEW RACE ONLY/)
  await click(view, 'draft-export')
  const spec = JSON.parse(fixture.downloads.at(-1).contents).spec
  assert.equal(spec.reviews[0].bundleId, spec.catalog[0].id)
  assert.equal(spec.catalog[0].review, undefined, 'human decisions are retained outside semantic bundles')
})

test('input text survives composition and bundle rerenders, and task changes refuse pending text', async () => {
  const view = await mount()
  fill(view, 'expected', '"Unapplied result"')
  await wrap(view)
  assert.equal(f(view, 'expected').value, '"Unapplied result"')
  await click(view, 'apply-bundle')
  assert.equal(f(view, 'expected').value, '"Unapplied result"')
  for (const action of ['add-task', 'delete-task']) {
    await click(view, action)
    assert.match(message(view), /Apply the current input edits/)
    assert.equal(f(view, 'task').querySelectorAll('option').length, 2)
    assert.equal(f(view, 'expected').value, '"Unapplied result"')
  }
  const draft = JSON.parse(f(view, 'task-json').value); draft.root.slots.task.params = { instruction: 'Typed task JSON' }
  const text = JSON.stringify(draft)
  fill(view, 'task-json', text)
  await wrap(view)
  assert.equal(f(view, 'task-json').value, text)
  await click(view, 'apply-task')
  assert.equal(f(view, 'expected').value, '"Unapplied result"')
  await click(view, 'apply-input')
  assert.equal(JSON.parse(f(view, 'task-json').value).expected, 'Unapplied result')
})

test('split and parameter changes refuse a pending task JSON replacement without losing it', async () => {
  const view = await mount(), text = f(view, 'task-json').value + '\n '
  fill(view, 'task-json', text)
  await choose(view, 'split', 'held-out')
  assert.equal(f(view, 'split').value, 'development')
  const parameter = view.el.querySelectorAll('[data-node-param]').find(input => input.dataset.nodeParam === 'a')
  parameter.value = '90'; parameter.dispatch('change'); await idle(view)
  assert.equal(String(parameter.value), '2')
  assert.equal(f(view, 'task-json').value, text)
})

test('new bundles refuse pending wording, and unrelated protocol application keeps full JSON text', async () => {
  const view = await mount()
  fill(view, 'wording', 'Unapplied wording')
  const startingBundles = f(view, 'bundle').querySelectorAll('option').length
  for (const action of ['add-atom', 'add-template', 'clone-bundle']) {
    await click(view, action)
    assert.equal(f(view, 'wording').value, 'Unapplied wording')
    assert.equal(f(view, 'bundle').querySelectorAll('option').length, startingBundles, 'a refused add leaves the library exactly as it was')
  }
  const fullText = f(view, 'spec-json').value + '\n '
  fill(view, 'spec-json', fullText)
  fill(view, 'decisions', 'Unapplied decisions')
  fill(view, 'attachment-path', 'data/input.txt'); fill(view, 'attachment-text', 'fixture')
  await click(view, 'attach')
  assert.equal(f(view, 'decisions').value, 'Unapplied decisions')
  assert.equal(f(view, 'spec-json').value, fullText)
  assert.equal(f(view, 'attachments').querySelectorAll('li').length, 0)
  await click(view, 'apply-protocol')
  assert.equal(f(view, 'spec-json').value, fullText)
  assert.equal(f(view, 'wording').value, 'Unapplied wording')
})

test('attachments pin their exact bytes, update and remove their digest, and refuse mismatched imports', async () => {
  const view = await mount()
  for (const contents of ['first fixture', 'second fixture']) {
    fill(view, 'attachment-path', 'data/input.txt'); fill(view, 'attachment-text', contents)
    await click(view, 'attach')
    assert.deepEqual(JSON.parse(f(view, 'inputs').value), [{ path: 'data/input.txt', sha256: await sha256(contents) }])
  }
  const spec = JSON.parse(f(view, 'spec-json').value)
  await importDraft(view, { spec, attachments: { 'data/input.txt': 'different bytes' } })
  await click(view, 'freeze')
  assert.match(message(view), /contents disagree with the input manifest/)
  assert.equal(f(view, 'export').disabled, true)
  view.el.querySelector('[data-remove-attachment]').click(); await idle(view)
  assert.deepEqual(JSON.parse(f(view, 'inputs').value), [])
  assert.equal(f(view, 'attachments').querySelectorAll('li').length, 0)
})

test('an incomplete draft name and unapplied editor text survive save and remount', async () => {
  const first = await mount()
  fill(first, 'name', '')
  fill(first, 'expected', 'unfinished JSON')
  fill(first, 'attachment-path', 'adapters/unfinished.mjs')
  fill(first, 'attachment-text', 'export async function run(')
  await click(first, 'save')
  first.destroy(); first.el.remove()
  const restored = await mount()
  assert.equal(f(restored, 'name').value, '')
  assert.equal(f(restored, 'expected').value, 'unfinished JSON')
  assert.equal(f(restored, 'attachment-text').value, 'export async function run(')
  await click(restored, 'freeze')
  assert.match(message(restored), /pending editor changes.*input.*attachment/)
})

test('recorded runs lock draft controls, permit cancellation, and restore frozen evidence by project', async () => {
  const view = await mount()
  await recordedDiagnostic(view)
  await click(view, 'freeze')
  const frozenText = f(view, 'frozen').textContent
  f(view, 'run').click()
  assert.equal(f(view, 'name').disabled, true)
  assert.equal(node(view, 'wrap').disabled, true)
  assert.equal(f(view, 'import').disabled, true)
  assert.equal(f(view, 'cancel').disabled, false)
  assert.equal(view.el.querySelector('[data-bench-tab]').disabled, false)
  f(view, 'cancel').click(); await idle(view)
  assert.match(message(view), /Run cancelled/)
  assert.equal(f(view, 'export-evidence').disabled, false)
  await view.setContext(B, 'live')
  assert.equal(f(view, 'export').disabled, true)
  await view.setContext(A, 'live')
  await useArithmeticExample(view, { examples: true })
  assert.equal(f(view, 'frozen').textContent, frozenText)
  assert.equal(f(view, 'export').disabled, false)
  assert.equal(f(view, 'export-evidence').disabled, false)
})

test('a delayed draft import cannot replace another project and undo stays within its project', async () => {
  const view = await mount(), gate = deferred()
  await click(view, 'use-starter')
  assert.equal(f(view, 'undo').hidden, false)
  f(view, 'import').files = [{ size: 100, text: () => gate.promise }]
  f(view, 'import').dispatch('change')
  await view.setContext(B, 'live')
  fill(view, 'name', 'Keep selected B')
  gate.resolve(JSON.stringify({ spec: { ...genericStarter(), name: 'Delayed import' } })); await pause()
  assert.equal(f(view, 'name').value, 'Keep selected B')
  assert.equal(f(view, 'undo').hidden, true)
  await view.setContext(A, 'live')
  await useArithmeticExample(view, { examples: true })
  assert.equal(f(view, 'undo').hidden, false)
})

test('nested templates expose collapsed branches and retain an expanded branch after a rerender', async () => {
  const view = await mount()
  await wrap(view); await wrap(view)
  const branch = node(view, 'branch', 'task.task')
  assert.ok(branch)
  assert.equal(branch.hasAttribute('open'), false)
  // The stand-in does not implement HTMLDetailsElement.open; set the native
  // property used by the component to model a person opening this branch.
  branch.open = true
  await click(view, 'apply-bundle')
  assert.equal(node(view, 'branch', 'task.task').hasAttribute('open'), true)
  assert.match(f(view, 'task-json').value, /context/)
})

test('the Lean prompt preview shows the frozen execution appendix and code grading stays in the exported runtime', async () => {
  const view = await mount(), spec = await bindLeanReview(leanStarter(), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, 'SYNTHETIC UI TEST ONLY', undefined, { catalog: spec.catalog })))
  await importDraft(view, { spec })
  await click(view, 'freeze')
  assert.match(f(view, 'preview-meta').textContent, /Frozen prompt/)
  assert.match(f(view, 'prompt').textContent, /Execution appendix/)
  // The compiler knows which layer contributed which characters; the page shows it.
  assert.match(f(view, 'layers-caption').textContent,
    /^Layer map for flat-canary, in UTF-16 code units\. Prompt SHA-256 [0-9a-f]{64}\./)
  const layers = f(view, 'layers').textContent
  for (const column of ['Start', 'End', 'Node path', 'Bundle', 'Requirement']) assert.ok(layers.includes(column), column)
  assert.ok(layers.includes('constitution-v1'), 'the outermost layer is named')
  assert.ok(layers.includes('runtime appendix'), 'the runtime appendix range names itself')
  assert.match(f(view, 'prompt').textContent, /Frozen completed-bar inputs/)
  await choose(view, 'task', '0')
  assert.match(f(view, 'prompt').textContent, /Execution appendix/)
  fill(view, 'grading', 'lean-python')
  fill(view, 'environment', JSON.stringify({ ...spec.environment, leanImage: 'synthetic/lean@sha256:' + 'a'.repeat(64) }))
  fill(view, 'timeout', '120')
  await until(() => f(view, 'preview-meta').textContent.includes('Draft prompt'))
  assert.match(f(view, 'prompt').textContent, /Execution appendix/, 'Drafts use the same task compiler and execution contract as frozen prompts')
  await click(view, 'apply-protocol'); await click(view, 'freeze')
  assert.equal(f(view, 'export').disabled, false)
  assert.equal(f(view, 'run').disabled, true)
  // The help for this benchmark's own grading contract is visible, and it is the
  // text Lean Bench declares rather than copy this page carries. The slot is no
  // longer named after one vertical, which is why the address changed.
  assert.equal(f(view, 'grading-help').hidden, false)
  assert.match(f(view, 'grading-help').textContent, /immutable Docker image digest/)
  // The starter ships its canary as the order trace its own JSON grader compares.
  // Under lean-python that same slot is executed as Python, so a trace can only
  // record no-program and readiness refuses the study before an engine run is
  // paid for. Changing the grader has to move the shipped canary with it.
  const recorded = JSON.parse(f(view, 'conditions').value)[0].adapter.responses['flat-canary']
  assert.equal(typeof recorded, 'string', 'the recorded canary is a program under lean-python')
  assert.match(recorded, /from AlgorithmImports import \*/)
  assert.ok(!recorded.includes('from lean_reference import Reference'),
    'the pinned reference is inlined, because gradeLean writes only main.py into the container')
  assert.doesNotMatch(f(view, 'readiness').textContent, /replay-response-not-a-program|is a JSON value, not a program/)
})

test('the shipped Lean Bench starter is eligible for apparatus development under lean-python', async () => {
  const view = await mount()
  const spec = await bindLeanReview(newExperimentDraft(leanStarter(), { purpose: 'apparatus-development', initializePopulation: true }), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, 'SYNTHETIC UI TEST ONLY', undefined, { catalog: spec.catalog })))
  await importDraft(view, { spec })
  fill(view, 'grading', 'lean-python')
  fill(view, 'environment', JSON.stringify({ ...spec.environment, leanImage: 'synthetic/lean@sha256:' + 'a'.repeat(64) }))
  fill(view, 'timeout', '900')
  await click(view, 'apply-protocol')
  assert.match(message(view), /recorded canary for flat-canary now carries the generated reference program/)
  await click(view, 'freeze')
  // Nothing stands between the starter and the one grader Lean Bench exists for.
  assert.doesNotMatch(f(view, 'readiness').textContent, /Execution is blocked by the following requirements/,
    f(view, 'readiness').textContent)
  assert.match(f(view, 'readiness').textContent, /Apparatus testing is available/)
  assert.equal(f(view, 'export').disabled, false)
  await click(view, 'export')
  assert.doesNotMatch(message(view), /It cannot run yet/, 'an eligible export is not warned about')
})

test('an investigator’s own recorded response is never rewritten when the Lean grader changes', async () => {
  const view = await mount(), spec = await bindLeanReview(leanStarter(), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, 'SYNTHETIC UI TEST ONLY', undefined, { catalog: spec.catalog })))
  spec.conditions[0].adapter.responses['flat-canary'] = { authored: 'my own recorded answer' }
  await importDraft(view, { spec })
  fill(view, 'grading', 'lean-python')
  fill(view, 'environment', JSON.stringify({ ...spec.environment, leanImage: 'synthetic/lean@sha256:' + 'a'.repeat(64) }))
  fill(view, 'timeout', '120')
  await click(view, 'apply-protocol')
  assert.deepEqual(JSON.parse(f(view, 'conditions').value)[0].adapter.responses['flat-canary'],
    { authored: 'my own recorded answer' }, 'only the shipped canary may move')
  await click(view, 'freeze')
  assert.match(f(view, 'readiness').textContent, /is a JSON value, not a program/,
    'readiness keeps explaining a response the page did not write')
  // Exporting a blocked project is allowed, but the person must not be told only
  // that it exported: the ZIP cannot run until those requirements are answered.
  await click(view, 'export')
  assert.match(message(view), /Runnable project exported/)
  assert.match(message(view), /It cannot run yet/, message(view))
  assert.match(message(view), /generated execution requirement/, message(view))
})

test('changed Lean apparatus source remains visible for another review after freeze refuses it', async () => {
  let code = sources
  const view = await mount({ loadSources: async () => code }), spec = await bindLeanReview(leanStarter(), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, 'SYNTHETIC UI TEST ONLY', undefined, { catalog: spec.catalog })))
  await importDraft(view, { spec }); await click(view, 'freeze')
  assert.equal(f(view, 'export').disabled, false)
  code = { ...sources, 'cli.mjs': sources['cli.mjs'] + '\n// Synthetic changed apparatus source.\n' }
  await click(view, 'freeze')
  assert.match(message(view), /needs review/)
  assert.equal(f(view, 'export').disabled, true)
  assert.equal(f(view, 'run').disabled, true)
  const current = JSON.parse(f(view, 'spec-json').value)
  assert.equal(current.catalog.find(bundle => bundle.id === 'constitution-v1').hooks.sourceHashes['cli.mjs'], await sha256(code['cli.mjs']))
})

test('information authoring prepares exact packets, invalidates changed readings and never displays a stale packet after an invalid edit', async () => {
  const view = await mount(), spec = informationFixture(), information = spec.tasks[0].information
  delete spec.tasks[0].information
  await importDraft(view, { spec }); await click(view, 'add-information')
  assert.equal(f(view, 'information-details').hidden, false)
  fill(view, 'information-paths', JSON.stringify(information.withheldPaths))
  fill(view, 'information-readings', JSON.stringify(information.readings))
  await click(view, 'apply-information'); await click(view, 'prepare-information')
  const packet = JSON.parse(f(view, 'information-packet').textContent)
  assert.equal(packet.readings.length, 2); assert.equal(packet.prompt, 'Produce the requested number.\n')
  fill(view, 'information-reviewer', 'SYNTHETIC UI INFORMATION ONLY'); await click(view, 'approve-information')
  await until(() => f(view, 'information-review-status').textContent.includes('has a current review'))
  await click(view, 'freeze'); assert.equal(f(view, 'export').disabled, false)
  fill(view, 'information-rationale', 'Changed rationale that needs a fresh review.')
  await click(view, 'apply-information')
  await until(() => f(view, 'information-review-status').textContent.includes('no current review'))
  await click(view, 'approve-information'); assert.match(message(view), /Prepare and inspect/)
  fill(view, 'information-paths', '["root/missing"]'); await click(view, 'apply-information')
  await until(() => f(view, 'preview-meta').textContent.includes('needs attention'))
  assert.equal(f(view, 'information-packet').textContent, '')
  await click(view, 'approve-information'); assert.match(message(view), /Prepare and inspect/)
})

test('corpus authoring retains sampling ledgers, refuses unmet coverage without replacing tasks and requires recipe regeneration after manual edits', async () => {
  const view = await mount(), spec = informationFixture(); delete spec.tasks[0].information
  await importDraft(view, { spec }); await click(view, 'seed-corpus')
  const recipe = JSON.parse(f(view, 'corpus-plan').value)
  recipe.families[0].axes = [{ id: 'value', choices: [1, 2].map(value => ({ id: `n-${value}`, edits: [
    { kind: 'parameter', path: ['rule'], name: 'value', value }, { kind: 'expected', value },
  ] })) }]
  recipe.coverage = [{ dimension: 'axis:value', minimum: 1 }]; recipe.selection = { kind: 'balanced', limit: 1 }
  fill(view, 'corpus-plan', JSON.stringify(recipe)); await click(view, 'generate-corpus')
  assert.match(message(view), /coverage-unmet/)
  assert.equal(JSON.parse(f(view, 'task-json').value).id, 'number-task')
  recipe.selection.limit = 2
  fill(view, 'corpus-plan', JSON.stringify(recipe)); await click(view, 'generate-corpus')
  assert.equal(f(view, 'task').querySelectorAll('option').length, 2)
  await click(view, 'freeze'); assert.equal(f(view, 'export').disabled, false)
  assert.equal(JSON.parse(f(view, 'corpus-ledger').textContent).manifest.selectedCount, 2)
  const task = JSON.parse(f(view, 'task-json').value); task.expected = 99
  fill(view, 'task-json', JSON.stringify(task)); await click(view, 'apply-task'); await click(view, 'freeze')
  assert.match(message(view), /tasks differ from their task recipe/)
  await click(view, 'detach-corpus')
  const detached = JSON.parse(f(view, 'spec-json').value)
  assert.equal(detached.corpusPlan, undefined); assert.equal(detached.corpusHistory.length, 1)
})

test('judge audit authoring imports pinned evidence, reviews every case, and displays eligible denominators without assigning unknown scores', async () => {
  const view = await mount(), { reference } = await auditFixture(sources), contents = JSON.stringify(reference)
  f(view, 'import-reference').files = [{ size: contents.length, text: async () => contents }]
  f(view, 'import-reference').dispatch('change'); await idle(view)
  assert.match(message(view), /Source reference verified/)
  assert.equal(f(view, 'audit-authoring').hidden, false)
  assert.ok(!JSON.parse(f(view, 'audit-plan').value).reference)
  const plan = JSON.parse(f(view, 'audit-plan').value)
  plan.criterion.kind = 'admissible-witness'
  fill(view, 'audit-plan', JSON.stringify(plan)); await click(view, 'generate-audit')
  assert.match(message(view), /4 audit cases generated; 2 have reference labels/)
  const generated = JSON.parse(f(view, 'spec-json').value)
  const conditions = ['accept', 'reject'].map(verdict => ({ ...generated.conditions[0], id: verdict, adapter: { kind: 'replay', responses: Object.fromEntries(generated.tasks.map(task => [task.id, { verdict }])) } }))
  fill(view, 'conditions', JSON.stringify(conditions)); await click(view, 'apply-protocol')
  fill(view, 'reviewer', 'SYNTHETIC UI JUDGE BUNDLE ONLY'); await click(view, 'approve')
  await click(view, 'prepare-audit')
  assert.match(message(view), /Current judge requests/, message(view))
  const first = JSON.parse(f(view, 'audit-packet').textContent)
  assert.equal(first.referenceBundleSha256, reference.sha256)
  assert.equal(first.analysisPlan.primaryPopulation, 'reference-eligible')
  fill(view, 'audit-reviewer', 'SYNTHETIC UI JUDGE CASE ONLY')
  for (let i = 0; i < 4; i++) {
    await choose(view, 'audit-case', String(i)); await click(view, 'approve-audit')
    assert.match(f(view, 'audit-review-status').textContent, /has a current review/)
  }
  await click(view, 'freeze'); assert.equal(f(view, 'run').disabled, false)
  await click(view, 'run')
  assert.match(f(view, 'results').textContent, /8 of 8 trials completed/)
  assert.match(f(view, 'results').textContent, /reference-eligible.*null scores/s)
  assert.match(f(view, 'results').textContent, /Eligible scheduled/)
  await click(view, 'export-evidence')
  const result = JSON.parse(fixture.downloads.at(-1).contents)
  assert.ok(result.summary.rows.filter(row => !row.referenceEligible).every(row => row.score === null))
  fill(view, 'audit-plan', 'unfinished JSON')
  await click(view, 'apply-analysis')
  assert.equal(f(view, 'audit-plan').value, 'unfinished JSON', 'unapplied audit edits survive protocol rendering')
  assert.equal(f(view, 'audit-packet').textContent, '')
  await click(view, 'approve-audit'); assert.match(message(view), /current audit edits/)
  await choose(view, 'audit-file', 'runtime/runner.mjs'); assert.equal(f(view, 'audit-file-text').textContent, sources['runner.mjs'])
  await view.setContext(B, 'live')
  assert.equal(f(view, 'audit-file-text').textContent, '')
  assert.equal(f(view, 'audit-reviewer').value, '')
  await view.setContext(A, 'live'); assert.equal(f(view, 'audit-plan').value, 'unfinished JSON')
})

test('source reference export is sealed and a delayed reference import cannot replace another project', async () => {
  const view = await mount(); await recordedDiagnostic(view); await click(view, 'freeze'); await click(view, 'run'); await click(view, 'export-reference')
  const reference = JSON.parse(fixture.downloads.at(-1).contents)
  await verifyAuditReference(reference)
  const gate = deferred()
  f(view, 'import-reference').files = [{ size: 100, text: () => gate.promise }]
  f(view, 'import-reference').dispatch('change')
  await view.setContext(B, 'live'); fill(view, 'name', 'Keep B while source is read')
  gate.resolve(JSON.stringify(reference)); await pause()
  assert.equal(f(view, 'name').value, 'Keep B while source is read')
  assert.equal(f(view, 'audit-authoring').hidden, true)
})

test('a changed audit runtime cannot receive approval through a previously prepared packet', async () => {
  let code = sources
  const view = await mount({ loadSources: async () => code }), { spec } = await auditFixture(sources)
  await importDraft(view, { spec }); await click(view, 'prepare-audit')
  const packet = JSON.parse(f(view, 'audit-packet').textContent)
  code = { ...sources, 'cli.mjs': sources['cli.mjs'] + '\n// SYNTHETIC SOURCE CHANGE ONLY\n' }
  fill(view, 'audit-reviewer', 'SYNTHETIC UI SOURCE REVIEW ONLY'); await click(view, 'approve-audit')
  assert.match(message(view), /apparatus source changed/)
  assert.equal(JSON.parse(f(view, 'spec-json').value).auditReviews, undefined)
  await click(view, 'prepare-audit')
  const updated = JSON.parse(f(view, 'audit-packet').textContent)
  assert.notEqual(updated.sha256, packet.sha256)
  assert.equal(updated.runtimeSources['cli.mjs'], await sha256(code['cli.mjs']))
})

test('accounting authoring preserves pending edits through save, context switches and protocol rendering, then exports the shared analysis', async () => {
  const view = await mount()
  await recordedDiagnostic(view)
  await click(view, 'seed-observations')
  const plan = JSON.parse(f(view, 'observation-plan').value)
  plan.rationale = 'SYNTHETIC UI ACCOUNTING ONLY'
  fill(view, 'observation-plan', JSON.stringify(plan)); await click(view, 'freeze')
  assert.match(message(view), /pending editor changes.*observations/)
  await click(view, 'save'); await view.setContext(B, 'live')
  assert.equal(f(view, 'observation-plan').value, 'null')
  await view.setContext(A, 'live'); assert.equal(JSON.parse(f(view, 'observation-plan').value).rationale, plan.rationale)
  await click(view, 'apply-protocol')
  assert.equal(JSON.parse(f(view, 'observation-plan').value).rationale, plan.rationale)
  await click(view, 'apply-observations'); assert.match(message(view), /Accounting plan applied/)
  assert.equal(JSON.parse(f(view, 'observation-contracts').textContent)[0].requested.model.id, 'arithmetic-v1')
  const conditions = JSON.parse(f(view, 'conditions').value)
  conditions[0].adapter.mode = 'envelope'
  conditions[0].adapter.responses = Object.fromEntries(Object.entries(conditions[0].adapter.responses).map(([id, output]) => [id, { output, usage: { inputTokens: 0, outputTokens: 7 }, completion: { status: 'complete' } }]))
  fill(view, 'conditions', JSON.stringify(conditions)); await click(view, 'apply-protocol')
  await click(view, 'freeze'); await click(view, 'run')
  assert.match(f(view, 'results').textContent, /All attempt resources/)
  await click(view, 'export-evidence')
  const evidence = JSON.parse(fixture.downloads.at(-1).contents)
  assert.equal(evidence.summary.observations.totals.usage.inputTokens.total, '0')
  assert.equal(evidence.summary.observations.totals.usage.outputTokens.total, '14')
  assert.equal(evidence.summary.observations.totals.reportedCost.byOrigin[0].status, 'unavailable')
  fill(view, 'observation-plan', 'unfinished accounting JSON'); await click(view, 'apply-observations')
  assert.match(message(view), /must be valid JSON/)
  assert.equal(f(view, 'export').disabled, true)
  assert.equal(f(view, 'observation-plan').value, 'unfinished accounting JSON')
})

test('operational draft authoring previews native observations, derives changed inputs and preserves personal review gates', async () => {
  const view = await mount()
  await choose(view, 'starter', 'lean-operational'); await click(view, 'use-starter')
  await until(() => f(view, 'prompt').textContent.includes('lean-operational-observation'))
  assert.match(f(view, 'prompt').textContent, /semantic answer/)
  assert.doesNotMatch(f(view, 'prompt').textContent, /Return only Python|Implement class FrozenBenchmark/)
  assert.equal(f(view, 'derive-expected').hidden, false)
  assert.equal(f(view, 'bundle-role').value, 'contract')
  assert.ok(f(view, 'combination-wrapper').querySelectorAll('option').some(option => option.value === 'op-race-filled-2'))
  node(view, 'wrapper').value = 'op-all-3'; node(view, 'wrap').click(); await idle(view)
  await until(() => f(view, 'prompt').textContent.includes('ALL with 3 Node children'))
  assert.equal(JSON.parse(f(view, 'task-json').value).root.slots.child3.use, 'op-strategy')
  const input = JSON.parse(f(view, 'input').value); input.market.maxFillQuantity = 1
  fill(view, 'input', JSON.stringify(input)); await click(view, 'apply-input')
  await click(view, 'derive-expected')
  assert.match(message(view), /Draft expected observation derived/)
  assert.ok(JSON.parse(f(view, 'expected').value).events.filter(event => event.quantity).every(event => Math.abs(event.quantity) === 1))
  await click(view, 'freeze'); assert.match(message(view), /needs review/)
  await click(view, 'save'); await click(view, 'draft-export')
  const draft = JSON.parse(fixture.downloads.at(-1).contents)
  assert.equal(draft.spec.leanProfile, 'operational-v1')
  assert.equal(draft.spec.requireReview, true)
  assert.equal(draft.spec.catalog.length, (await operationalStarter()).catalog.length)
  assert.equal(draft.spec.reviews?.length || 0, 0)
})

// ---------------------------------------------------------------------------
// WHICH FIELDS THIS PAGE SHOWS IS A BENCHMARK'S DECLARATION, NOT THIS PAGE'S
// OPINION.
//
// Sixteen branches on spec.domain === 'lean-bench' used to decide which fields
// and controls appeared -- the trace panel, combinations, derive-expected, the
// grading help and whether one vertical's grading contract was selectable. A
// third party got a page shaped for Lean Bench: fields it does not need, and no
// way to declare the ones it does. These two tests register a benchmark that
// exists only inside this file and check the page renders what IT declares.
const THIRD_PARTY_HELP = 'Compares the returned query after normalising whitespace and case.'
function thirdPartyBenchmark() {
  return {
    id: 'sql-bench', label: 'SQL Bench', domains: ['sql-bench'],
    matches: spec => spec?.domain === 'sql-bench',
    gradingKinds: [{ value: 'sql-compare', title: 'SQL comparison', label: 'Normalised SQL comparison', help: THIRD_PARTY_HELP }],
    // It wants the combination control and nothing else: no trace panel, and it
    // does not derive expected observations.
    page: { fields: ['combinations'], derivesExpected: false },
  }
}
function thirdPartyDraft() {
  const draft = newExperimentDraft(genericStarter(), { initializePopulation: true })
  draft.id = 'sql-bench-study'; draft.name = 'SQL Bench'; draft.domain = 'sql-bench'
  return draft
}
async function withBenchmark(descriptor, body) {
  const shipped = registeredBenchmarks()
  resetRegistry()
  for (const entry of shipped) registerBenchmark(entry)
  registerBenchmark(descriptor)
  try { return await body() } finally { resetRegistry(); for (const entry of shipped) registerBenchmark(entry) }
}
const options = view => [...f(view, 'grading').querySelectorAll('option')]
const optionFor = (view, value) => options(view).find(item => item.getAttribute('value') === value)

test('a study that declares no benchmark gets none of a benchmark\u2019s fields, and cannot choose its grading contract', async () => {
  const view = await mount()
  for (const name of ['trace-details', 'combinations', 'derive-expected', 'grading-help']) {
    assert.equal(f(view, name).hidden, true, `${name} belongs to a benchmark, and this study has none`)
  }
  // Every registered contract is listed, so a person can see what exists; one
  // that belongs to a benchmark this study is not in cannot be chosen.
  assert.ok(optionFor(view, 'exact') && !optionFor(view, 'exact').hasAttribute('disabled'))
  assert.ok(optionFor(view, 'lean-python'), 'a registered contract is still offered')
  assert.equal(optionFor(view, 'lean-python').hasAttribute('disabled'), true)
  // And the page refuses the action the declaration does not carry, by asking
  // for a benchmark rather than for one vertical by name.
  f(view, 'derive-expected').click(); await idle(view)
  assert.match(message(view), /benchmark that derives expected observations/,
    'the refusal asks for a benchmark that derives them, not for one vertical by name')
})

test('a benchmark ToolsEnabled did not write declares its own page fields and grading contract, and the page renders from that', async () => {
  await withBenchmark(thirdPartyBenchmark(), async () => {
    const view = await mount()
    await importDraft(view, { spec: thirdPartyDraft() })
    // Declared: shown. Not declared: absent, including the fields Lean Bench uses.
    assert.equal(f(view, 'combinations').hidden, false)
    assert.equal(f(view, 'trace-details').hidden, true)
    assert.equal(f(view, 'derive-expected').hidden, true)
    // Its own grading contract is selectable and described in its own words;
    // the other benchmark's contract is not selectable here.
    assert.equal(optionFor(view, 'sql-compare').hasAttribute('disabled'), false)
    assert.equal(optionFor(view, 'sql-compare').textContent, 'Normalised SQL comparison')
    assert.equal(optionFor(view, 'lean-python').hasAttribute('disabled'), true)
    assert.equal(f(view, 'grading-help').hidden, false)
    assert.equal(f(view, 'grading-help').textContent, THIRD_PARTY_HELP)
  })
})
