import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { RUNTIME_FILES, bindRuntimeSources } from '../../src/benchmark/study.mjs'
import { createReviewRecord } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'

// The Research page must show every important step of a lean-bench run explicitly: after Freeze, the
// schedule, the conditions as frozen, the protocol and native grading contract and the runtime pins;
// after a run or an evidence import, when it ran, on what runtime, and why each trial ended as it did.
// At 709876dd the page showed a count line after Freeze and per-condition rates after a run, nothing else.

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36)
const IMAGE = 'quantconnect/lean@sha256:' + 'c'.repeat(64)
const PROGRAM = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def Initialize(self):\n        pass\n'
const views = []
let installed, cryptoDescriptor, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const message = view => f(view, 'status').textContent
async function idle(view) {
  for (let i = 0; i < 400; i++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('the benchmark UI did not settle: ' + message(view))
}
function fill(view, name, value) { const input = f(view, name); assert.ok(input, name); assert.equal(input.disabled, false, name); input.value = value; input.dispatch('input') }
async function click(view, name) { assert.ok(f(view, name), name); assert.equal(f(view, name).disabled, false, `${name} is available: ${message(view)}`); f(view, name).click(); await idle(view) }
const memoryAccount = () => {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount() {
  const view = createBenchmarkBuilder({ account: memoryAccount(), loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function importDraft(view, spec) {
  const contents = JSON.stringify({ spec })
  f(view, 'import').files = [{ size: contents.length, text: async () => contents }]
  f(view, 'import').dispatch('change'); await idle(view)
}
async function leanBenchDraft() {
  // The starter, switched to real-engine grading the way the documentation describes, with its
  // recorded canary carrying a program so readiness admits it. Lean Bench requires current bundle
  // reviews before freezing; the records below are synthetic and say so, exactly as other builder tests do.
  let spec = newExperimentDraft(leanStarter(), { purpose: 'apparatus-development', initializePopulation: true })
  // The run of record's budgets: the engine timeout must fit inside the attempt timeout.
  spec.protocol.timeoutMs = 900000; spec.protocol.maxDurationMs = 5400000
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 420000 }
  spec.environment.leanImage = IMAGE
  spec.conditions[0].adapter.responses['flat-canary'] = PROGRAM
  spec.conditions[0].model = { ...spec.conditions[0].model, surface: 'saved-response' }
  spec.conditions.push({ id: 'reference-program', label: 'Trusted generated reference program', model: { provider: 'apparatus-control', id: 'generated-reference-program', surface: 'local-command', settings: {} },
    adapter: { kind: 'command', command: 'node', args: ['adapters/reference-program.mjs'], env: ['HOME'] } })
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC UI TEST RECORD; NO PERSONAL APPROVAL', { at: '2026-09-11T00:00:00.000Z' })))
  return spec
}

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  downloads = []
})
afterEach(() => {
  for (const view of views.splice(0)) view.destroy?.()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
  installed.restore()
})

test('after Freeze the page shows the schedule, the frozen conditions, the native grading contract and the runtime pins', async () => {
  const view = await mount()
  await importDraft(view, await leanBenchDraft())
  assert.ok(f(view, 'frozen-inspection'), 'the frozen inspection container exists')
  assert.equal(f(view, 'frozen-inspection').textContent, '', 'nothing is shown before a freeze')
  await click(view, 'freeze')
  assert.match(message(view), /Project frozen/)
  const text = f(view, 'frozen-inspection').textContent
  for (const expected of ['flat-canary.recorded.1', 'flat-canary.reference-program.1', 'lean-python', IMAGE, 'node adapters/reference-program.mjs', 'apparatus-control', 'generated-reference-program', 'Saved responses; no provider call', `${RUNTIME_FILES.length} files`, 'lean-grade.mjs pinned at SHA-256', '420000', 'apparatus-development', 'HOME'])
    assert.ok(text.includes(expected), `frozen inspection shows ${expected}`)
  assert.ok(!text.includes('FrozenBenchmark(QCAlgorithm)'), 'saved responses are not rendered as configuration')
  assert.equal(view.el.querySelectorAll('[data-bench-journal-pins] tr').length, RUNTIME_FILES.length + 1)
  // Editing the protocol invalidates the frozen project; the inspection disappears with it.
  fill(view, 'seed', '43'); await click(view, 'apply-protocol')
  assert.match(f(view, 'frozen').textContent, /draft changed/)
  assert.equal(f(view, 'frozen-inspection').textContent, '')
})

test('after a recorded-response run the page shows the run header, the journal timing and the trial dispositions by condition', async () => {
  const view = await mount()
  await importDraft(view, newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true }))
  await click(view, 'freeze')
  assert.ok(f(view, 'frozen-inspection').textContent.includes('Saved responses; no provider call'))
  await click(view, 'run')
  const results = f(view, 'results')
  assert.match(results.textContent, /trials completed/)
  assert.ok(results.querySelector('[data-bench-journal-run]'), 'the run header is rendered inside the results')
  assert.ok(results.querySelector('[data-bench-journal-dispositions]'), 'the disposition table is rendered inside the results')
  const text = results.textContent
  assert.ok(text.includes('First attempt started'), 'the header names when the first attempt started')
  assert.match(text, /20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ/)
  assert.ok(text.includes('recorded-diagnostic'), 'the execution purpose is shown')
  // An in-page recorded-response run records the renderer it ran on (its user agent), never a guessed Node version.
  assert.ok(text.includes('Runtime') && text.includes('research-page: ' + globalThis.navigator.userAgent), 'the page run declares the renderer runtime')
  assert.ok(!text.includes('node undefined'), 'nothing is invented for the runner-only fields')
  const rows = results.querySelectorAll('[data-bench-journal-dispositions] tbody tr')
  assert.ok(rows.length >= 1, 'at least one disposition row per condition')
  assert.ok(rows.every(row => /^\d+$/.test(row.children.at(-1).textContent)), 'every disposition row ends with a trial count')
})
