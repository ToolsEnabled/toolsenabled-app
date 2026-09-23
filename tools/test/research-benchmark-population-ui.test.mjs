import { useArithmeticExample } from './lib/benchmark-example.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
async function idle(view) {
  for (let i = 0; i < 200; i++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('The population editor did not settle.')
}
function fill(view, name, value) { const input = field(view, name); assert.equal(input.disabled, false); input.value = value; input.dispatch('input') }
async function click(view, name) { assert.equal(field(view, name).disabled, false); field(view, name).click(); await idle(view) }
async function mount() {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); await useArithmeticExample(view); return view
}
async function importDraft(view, spec) {
  const contents = JSON.stringify({ spec })
  field(view, 'import').files = [{ size: contents.length, text: async () => contents }]
  field(view, 'import').dispatch('change'); await idle(view)
}
async function exportedSpec(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents).spec }
beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map(); downloads = []
  account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('population fields preserve invalid task text through failed apply, save and remount, then resolve a valid roster in task order', async () => {
  let view = await mount()
  fill(view, 'analysis-population', 'task-set')
  assert.equal(field(view, 'analysis-task-ids-field').hidden, false)
  const invalid = 'addition-b,\n unknown-task '
  fill(view, 'analysis-task-ids', invalid)
  await click(view, 'apply-analysis')
  assert.match(field(view, 'status').textContent, /task|unknown/i)
  assert.equal(field(view, 'analysis-task-ids').value, invalid)
  assert.match(field(view, 'analysis-population-preview').textContent, /2 included tasks; 0 excluded tasks/)
  assert.match(field(view, 'analysis-population-preview').textContent, /Apply the current analysis edits/)
  await click(view, 'freeze'); assert.match(field(view, 'status').textContent, /pending.*analysis|analysis.*edits/i)
  await click(view, 'save'); await view.setContext(B, 'live')
  assert.equal(field(view, 'analysis-population').value, 'all')
  await view.setContext(A, 'live'); assert.equal(field(view, 'analysis-task-ids').value, invalid)
  view.destroy(); view.el.remove(); views.splice(views.indexOf(view), 1)
  view = await mount()
  assert.equal(field(view, 'analysis-population').value, 'task-set')
  assert.equal(field(view, 'analysis-task-ids').value, invalid)
  assert.equal(field(view, 'analysis-task-ids-field').hidden, false)
  fill(view, 'analysis-task-ids', 'addition-b,\naddition-a')
  await click(view, 'apply-analysis')
  assert.match(field(view, 'status').textContent, /Analysis plan applied/)
  assert.deepEqual((await exportedSpec(view)).analysisPlan.primaryPopulation, { kind: 'task-set', taskIds: ['addition-b', 'addition-a'] })
  const rows = field(view, 'analysis-population-preview').querySelectorAll('tbody tr')
  assert.equal(rows[0].querySelector('th').textContent, 'addition-a')
  assert.equal(rows[1].querySelector('th').textContent, 'addition-b')
})

test('held-out fields control the primary results while all scheduled outcomes remain visible', async () => {
  const view = await mount(), spec = genericStarter()
  spec.conditions[0].adapter.responses['addition-a'] = 'wrong'
  await importDraft(view, spec)
  fill(view, 'analysis-population', 'held-out'); await click(view, 'apply-analysis')
  assert.deepEqual((await exportedSpec(view)).analysisPlan.primaryPopulation, { kind: 'split', split: 'held-out' })
  assert.match(field(view, 'analysis-population-preview').textContent, /1 included tasks; 1 excluded tasks/)
  await click(view, 'freeze'); await click(view, 'run')
  const primary = field(view, 'primary-results'), all = field(view, 'all-results')
  assert.match(primary.textContent, /1 scheduled trials included; 1 scheduled trials excluded/)
  assert.match(primary.textContent, /100\.0%/)
  assert.doesNotMatch(primary.textContent, /50\.0%/)
  assert.match(all.textContent, /All frozen tasks/)
  assert.match(all.textContent, /50\.0%/)
  fill(view, 'analysis-population', 'development'); await click(view, 'apply-analysis')
  assert.deepEqual((await exportedSpec(view)).analysisPlan.primaryPopulation, { kind: 'split', split: 'development' })
})

test('audits preserve their fixed eligible-case population and no-plan studies have no inferred primary results', async () => {
  const view = await mount(), audit = await auditFixture(sources)
  await importDraft(view, audit.spec)
  assert.equal(field(view, 'analysis-population').value, 'reference-eligible')
  assert.equal(field(view, 'analysis-population').disabled, true)
  assert.equal(field(view, 'analysis-task-ids-field').hidden, true)
  await click(view, 'apply-analysis')
  assert.equal((await exportedSpec(view)).analysisPlan.primaryPopulation, 'reference-eligible')
  const unplanned = genericStarter(); delete unplanned.analysisPlan
  await importDraft(view, unplanned)
  assert.equal(field(view, 'analysis-population').disabled, false)
  assert.match(field(view, 'analysis-population-preview').textContent, /No primary population is applied/)
  await click(view, 'freeze'); await click(view, 'run')
  assert.equal(field(view, 'primary-results'), null)
  assert.match(field(view, 'results').textContent, /No primary denominator was declared/)
  assert.ok(field(view, 'all-results'))
})
