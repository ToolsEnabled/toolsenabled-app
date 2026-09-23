// Freeze & run opens with a read-only review of the study: identity, prompts,
// conditions, budgets, decisions, pipeline, analysis, unapplied edits and the
// frozen state, and the Watch line follows an in-page run.
import { useArithmeticExample } from './lib/benchmark-example.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36)
const views = []
let installed, fixture, cryptoDescriptor
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause() } assert.fail('the benchmark UI did not settle') }
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
function fill(view, name, value) { const input = f(view, name); assert.equal(input.disabled, false); input.value = value; input.dispatch('input') }
async function click(view, name) { assert.equal(f(view, name).disabled, false, `${name} is available`); f(view, name).click(); await idle(view) }
async function mount(options = {}) {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources, download: () => {}, ...options })
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

test('the review reads the study, names unapplied edits, and follows freezing and the in-page run', async () => {
  let watched = 0
  const view = await mount({ onWatchRuns: () => { watched++ } })
  const spec = JSON.parse(f(view, 'spec-json').value)
  f(view, 'tab="run"').click(); await idle(view)
  const review = () => f(view, 'review').textContent
  assert.ok(review().includes(spec.name), 'the study name is in the review')
  assert.ok(review().includes(`${spec.tasks.length} tasks`), 'the task count is in the review')
  for (const condition of spec.conditions) assert.ok(review().includes(condition.id), `condition ${condition.id} is listed`)
  assert.ok(review().includes(`${spec.protocol.replicates} replicates`) && review().includes(`grading ${spec.protocol.grading.kind}`), 'budgets and grading are in the review')
  assert.ok(review().includes('0 of 55 decisions made'), 'decisions are counted')
  assert.ok(review().includes('No pipeline rows.'))
  assert.ok(review().includes('None') && !review().includes('apply them on their tabs'), 'nothing is unapplied')
  assert.ok(review().includes('Not frozen yet'))
  assert.equal(f(view, 'tab="run"').textContent, 'Freeze & run')
  // An unapplied protocol edit shows up by name.
  fill(view, 'decisions', 'A decision typed and not applied')
  assert.ok(review().includes('protocol') && review().includes('apply them on their tabs'), review())
  await click(view, 'apply-protocol')
  assert.ok(!review().includes('apply them on their tabs'))
  assert.ok(review().includes('A decision typed and not applied'), 'the frozen decisions text is quoted')
  // Freezing shows the trial count and the digest; the run reports on the Watch line.
  fill(view, 'execution-purpose', 'recorded-diagnostic'); await click(view, 'apply-execution')
  await click(view, 'freeze')
  const frozenLine = f(view, 'frozen').textContent
  assert.match(frozenLine, /scheduled trials · SHA-256 ([0-9a-f]{64})/)
  const digest = frozenLine.match(/SHA-256 ([0-9a-f]{64})/)[1]
  assert.ok(review().includes(digest.slice(0, 12)) && review().includes('trials'), review())
  assert.equal(f(view, 'run-live').textContent, 'No run is in progress on this page.')
  await click(view, 'run')
  assert.equal(f(view, 'run-live').textContent, 'Run finished. Evidence below.')
  assert.ok(f(view, 'results').textContent.includes('Run evidence'))
  f(view, 'watch-runs').click(); assert.equal(watched, 1)
})
