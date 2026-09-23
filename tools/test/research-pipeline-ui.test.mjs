// Decisions & pipeline: adding surfaces and pressing Generate writes command
// conditions through the condition fields and attaches the harness files,
// with the pipeline draft retained beside the study.
import { useArithmeticExample } from './lib/benchmark-example.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { createHash } from 'node:crypto'
import { generatePipeline, pipelineSettings } from '../../src/research-pipeline.mjs'
import { decisionsText, normalizeProtocolDecisions } from '../../src/research-protocol.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36)
const views = []
let installed, fixture, cryptoDescriptor
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause() } assert.fail('the benchmark UI did not settle') }
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const message = view => f(view, 'status').textContent
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
async function click(view, name) { assert.equal(f(view, name).disabled, false, `${name} is available`); f(view, name).click(); await idle(view) }
async function mount() {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources, download: () => {} })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live')
  await useArithmeticExample(view, { examples: true })
  await until(() => f(view, 'preview-meta').textContent.includes('components') && f(view, 'review-status').textContent.includes('SHA-256'))
  return view
}
beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fixture = { values: new Map() }
  fixture.account = { async getSetting(key) { return { ok: true, value: fixture.values.get(key) ?? null } }, async putSetting(key, value) { fixture.values.set(key, value); return { ok: true } } }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('generate turns surfaces × efforts into command conditions and attaches the harness', async () => {
  const view = await mount()
  f(view, 'tab="protocol"').click(); await idle(view)
  const pipe = name => view.el.querySelector(`[data-pipe-${name}]`)
  pipe('add').click(); await idle(view)
  const model = pipe('model="0"'); model.value = 'claude-sonnet-5'; model.dispatch('input')
  const high = [...view.el.querySelectorAll('[data-pipe-effort="0"]')].find(input => input.value === 'high'); high.checked = true; high.dispatch('change')
  assert.equal(pipe('noask="0"'), null)
  assert.match(pipe('preview').textContent, /2\s*conditions will be generated: claude-claude-sonnet-5-high, claude-claude-sonnet-5-max/)
  const retained = JSON.parse(f(view, 'pipeline-draft').value)
  assert.deepEqual(retained.rows, [{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: '', efforts: ['high', 'max'], noask: false }])
  const before = JSON.parse(f(view, 'spec-json').value).conditions.map(condition => condition.id)
  await click(view, 'generate-pipeline')
  assert.match(message(view), /Pipeline generated: 2 new conditions \(0 already present\) and 6 harness files attached/, message(view))
  const spec = JSON.parse(f(view, 'spec-json').value)
  assert.deepEqual(spec.conditions.map(condition => condition.id), [...before, 'claude-claude-sonnet-5-high', 'claude-claude-sonnet-5-max'])
  const generated = spec.conditions.find(condition => condition.id === 'claude-claude-sonnet-5-high')
  assert.deepEqual(generated.model, { provider: 'anthropic', id: 'claude-sonnet-5', surface: 'claude-cli', settings: { effort: 'high' } })
  assert.equal(generated.adapter.kind, 'command'); assert.equal(generated.adapter.command, 'node')
  assert.deepEqual(generated.adapter.args.slice(0, 7), ['harness/draw.mjs', '--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'high'])
  assert.equal(generated.adapter.args.length, 7)
  assert.deepEqual(generated.adapter.env, ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC'])
  for (const path of ['harness/surfaces.json', 'harness/clean-room.mjs', 'harness/draw.mjs', 'harness/canary.mjs', 'harness/judge.mjs', 'harness/README.md']) {
    const input = spec.inputs.find(item => item.path === path)
    assert.ok(input && /^[0-9a-f]{64}$/.test(input.sha256), `${path} is in the input manifest with its digest`)
  }
  assert.match(f(view, 'attachments').textContent, /harness\/draw\.mjs/)
  // Generating again adds nothing and says so.
  await click(view, 'generate-pipeline')
  assert.match(message(view), /0 new conditions \(2 already present\)/)
})

test('judges: set the number, each model, effort and prompt; the retained draft and the harness carry them', async () => {
  const view = await mount()
  f(view, 'tab="protocol"').click(); await idle(view)
  const pipe = name => view.el.querySelector(`[data-pipe-${name}]`)
  pipe('add').click(); await idle(view)
  const model = pipe('model="0"'); model.value = 'claude-sonnet-5'; model.dispatch('input')
  pipe('open-judges').click(); await idle(view)
  assert.equal(f(view, 'panel="audit"').hidden, false, 'Configure judges opens Judge audit')
  assert.equal(f(view, 'panel="protocol"').hidden, true)
  assert.equal(f(view, 'panel="audit"').querySelector('[data-pipe-judge-count]'), pipe('judge-count'), 'the count is visible without importing a reference')
  assert.equal(f(view, 'panel="protocol"').querySelector('[data-pipe-judge-count]'), null, 'there is only one judge editor')
  assert.match(pipe('judge-status').textContent, /No judges/)
  pipe('judge-add').click(); await idle(view)
  assert.equal(f(view, 'panel="audit"').querySelectorAll('[data-pipe-judge-prompt]').length, 1, 'Add judge reveals the prompt on Judge audit')
  const count = pipe('judge-count'); count.value = '2'; count.dispatch('change')
  assert.equal(view.el.querySelectorAll('[data-pipe-judge-prompt]').length, 2)
  assert.match(pipe('judge-status').textContent, /0\s*of 2 judges will be written/)
  assert.match(pipe('judge-status').textContent, /Judge 1 needs an exact model id and a judge prompt/)
  const surface = pipe('judge-surface="0"'); surface.value = 'codex-cli'; surface.dispatch('change')
  const first = pipe('judge-model="0"'); first.value = 'gpt-5.6-sol'; first.dispatch('input')
  const effort = pipe('judge-effort="0"'); effort.value = 'high'; effort.dispatch('change')
  const prompt = pipe('judge-prompt="0"'); prompt.value = 'Score the program against the task.'; prompt.dispatch('input')
  const second = pipe('judge-model="1"'); second.value = 'claude-sonnet-5'; second.dispatch('input')
  const secondPrompt = pipe('judge-prompt="1"'); secondPrompt.value = 'Also score it.'; secondPrompt.dispatch('input')
  assert.match(pipe('judge-status').textContent, /2\s*of 2 judges will be written/)
  assert.match(pipe('judge-status').textContent, /Judge 2 \(claude-sonnet-5\) is also a contestant/)
  const retained = JSON.parse(f(view, 'pipeline-draft').value)
  assert.deepEqual(retained.judges, [
    { surface: 'codex-cli', model: 'gpt-5.6-sol', effort: 'high', executable: '', prompt: 'Score the program against the task.' },
    { surface: 'claude-cli', model: 'claude-sonnet-5', effort: 'medium', executable: '', prompt: 'Also score it.' },
  ])
  pipe('open-pipeline').click(); await idle(view)
  assert.equal(f(view, 'panel="protocol"').hidden, false)
  assert.deepEqual(JSON.parse(f(view, 'pipeline-draft').value).judges, retained.judges, 'navigation preserves judge settings')
  await click(view, 'generate-pipeline')
  const spec = JSON.parse(f(view, 'spec-json').value)
  const decisions = f(view, 'protocol-decisions').value
  const state = normalizeProtocolDecisions(decisions ? JSON.parse(decisions) : null)
  const expected = generatePipeline(retained, pipelineSettings(state, spec.protocol)).files['harness/surfaces.json']
  assert.equal(JSON.parse(expected).judges.length, 2)
  assert.equal(spec.inputs.find(item => item.path === 'harness/surfaces.json').sha256, createHash('sha256').update(expected, 'utf8').digest('hex'), 'the attached surfaces.json is the one carrying both judges')
  // Fewer judges keeps the first one as written.
  f(view, 'tab="audit"').click(); await idle(view)
  const fewer = pipe('judge-count'); fewer.value = '1'; fewer.dispatch('change')
  assert.deepEqual(JSON.parse(f(view, 'pipeline-draft').value).judges.map(judge => judge.model), ['gpt-5.6-sol'])
})

test('old duplicate settings stay as reference while the single schedule controls the generated harness', async () => {
  const view = await mount()
  const original = JSON.parse(f(view, 'spec-json').value)
  // An already-authored instruction condition must survive regeneration.
  original.conditions[0].adapter = { kind: 'command', command: 'node', args: ['harness/draw.mjs', '--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'max', '--append', 'An existing instruction.'] }
  const legacy = normalizeProtocolDecisions({ values: { noask: 'yes', 'noask-text': 'A retired instruction.', 'draw-timeout': 40, 'n-eligible': 99, models: ['old-model'], 'study-kind': 'exploratory' }, notes: 'Keep these notes.' })
  original.decisions = decisionsText(legacy, { includeManaged: true })
  const pipeline = { version: 1, root: 'C:/lbres', rows: [{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: '', efforts: ['high', 'max'], noask: true }], judges: [] }
  assert.equal((await view.openDraft({ spec: original, editors: { 'data-bench-protocol-decisions': JSON.stringify(legacy), 'data-bench-pipeline-draft': JSON.stringify(pipeline) } }, 'previous-protocol.json')).ok, true)
  f(view, 'tab="protocol"').click(); await idle(view)
  const proto = name => view.el.querySelector(`[data-proto-${name}]`)
  for (const id of ['input-shape', 'system-line', 'noask', 'noask-text', 'conditions', 'models', 'surfaces', 'efforts', 'draw-timeout', 'n-eligible', 'grader', 'approval-loop', 'engine-pins', 'visible-input-frozen']) {
    assert.equal(proto(`field="${id}"`), null, `${id} has no duplicate control`)
  }
  assert.match(proto('previous').textContent, /A retired instruction/)
  assert.match(view.el.querySelector('[data-pipe-previous]').textContent, /Previous no-ask selections/)
  assert.equal(view.el.querySelector('[data-pipe-noask]'), null)
  await click(view, 'apply-protocol')
  const refreshed = JSON.parse(f(view, 'spec-json').value)
  assert.equal(refreshed.decisions, decisionsText(legacy), 'applying an old record removes duplicate declarations without copying them into notes')
  assert.equal(proto('notes').textContent, 'Keep these notes.')
  assert.deepEqual(JSON.parse(f(view, 'protocol-decisions').value).values, legacy.values)
  for (const [name, value] of [['timeout', '123.456'], ['replicates', '2']]) { f(view, name).value = value; f(view, name).dispatch('input') }
  proto('use-all').click(); await idle(view)
  assert.equal(f(view, 'timeout').value, '123.456', 'taking example rules does not overwrite the schedule')
  assert.equal(f(view, 'replicates').value, '2')
  assert.ok(!proto('text').textContent.includes('A retired instruction.'))
  await click(view, 'generate-pipeline')
  assert.match(message(view), /Pipeline generated: 2 new conditions/)
  const applied = JSON.parse(f(view, 'spec-json').value)
  assert.equal(applied.protocol.timeoutMs, 123456)
  assert.equal(applied.protocol.replicates, 2)
  assert.deepEqual(applied.conditions.slice(0, original.conditions.length), original.conditions, 'existing conditions are preserved exactly')
  assert.ok(applied.conditions.slice(original.conditions.length).every(condition => !condition.adapter.args.includes('--append')))
  assert.deepEqual(applied.catalog, original.catalog, 'snippets and parent instructions are unchanged')
  assert.deepEqual(applied.tasks, original.tasks, 'task prompts are unchanged')
  assert.deepEqual(applied.environment, original.environment)
  assert.deepEqual(applied.inputs.filter(input => !input.path.startsWith('harness/')), original.inputs, 'existing data declarations are unchanged')
  assert.ok(!applied.decisions.includes('A retired instruction.'))
  assert.ok(!applied.decisions.includes('Per-draw timeout:'))
  const retained = normalizeProtocolDecisions(JSON.parse(f(view, 'protocol-decisions').value))
  assert.equal(retained.values['noask-text'], 'A retired instruction.')
  const expected = generatePipeline(pipeline, pipelineSettings(retained, applied.protocol)).files['harness/surfaces.json']
  assert.equal(Math.round(JSON.parse(expected).timeoutMinutes * 60000), applied.protocol.timeoutMs)
  assert.equal(applied.inputs.find(input => input.path === 'harness/surfaces.json').sha256, createHash('sha256').update(expected).digest('hex'))
  await view.setContext('rp-' + 'b'.repeat(36), 'live'); await view.setContext(A, 'live')
  assert.equal(Number(f(view, 'timeout').value), 123.456)
  assert.match(proto('previous').textContent, /A retired instruction/)
  assert.equal(JSON.parse(f(view, 'pipeline-draft').value).rows[0].noask, true, 'the old draft is recoverable after restore')
})
