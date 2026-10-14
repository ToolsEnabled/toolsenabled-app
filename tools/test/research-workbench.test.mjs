import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { createResearchRegistry, RESEARCH_MODULE_STORE_KEY } from '../../src/research-modules.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')

/* The owner's amendment, verbatim: "I dont want the research page to be a
   chat window. Research workers still spawn on tree nodes, the research page
   is for researchers ... to quickly and easily set up experiments and see
   the results." The first test makes that a fence, not a memory. */

test('the research page has no chat surface', () => {
  const view = read('src/views/research.js')
  for (const marker of ['buildChat', 'chat-input', 'chat-send', 'chat-log', 'onSend', 'mcAgent.send']) {
    assert.ok(!view.includes(marker), `the research page grew a chat surface: ${marker}`)
  }
})

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

function fakeEl() {
  return { querySelector: () => null, remove() {} }
}

const MODULES = () => [
  { id: 'queue', title: 'Research queue', size: 'full', el: fakeEl() },
  { id: 'library', title: 'Report library', size: 'full', el: fakeEl() },
]

test('bad module wiring throws; it is a defect, not a condition', () => {
  assert.throws(() => createResearchRegistry({ modules: [] }), TypeError)
  assert.throws(() => createResearchRegistry({
    modules: [...MODULES(), { id: 'queue', title: 'Duplicate', size: 'full', el: fakeEl() }],
  }), /duplicate/)
  assert.throws(() => createResearchRegistry({
    modules: [{ id: 'x', title: 'X', size: 'huge', el: fakeEl() }],
  }), /size/)
})

test('every module is enabled by default, and the default face is stored as absence', () => {
  const storage = fakeStorage()
  const registry = createResearchRegistry({ modules: MODULES(), storage })
  assert.equal(registry.enabled().length, 2)
  registry.setEnabled('library', false)
  assert.deepEqual(JSON.parse(storage.dump()[RESEARCH_MODULE_STORE_KEY]), { v: 1, disabled: ['library'] })
  registry.setEnabled('library', true)
  assert.equal(storage.dump()[RESEARCH_MODULE_STORE_KEY], undefined,
    'the all-enabled default must be stored as absence, never as a pinned copy')
})

test('stored ids that no longer exist are dropped, and setAll flips the whole bench', () => {
  const storage = fakeStorage({
    [RESEARCH_MODULE_STORE_KEY]: JSON.stringify({ v: 1, disabled: ['gone-module', 'library'] }),
  })
  const registry = createResearchRegistry({ modules: MODULES(), storage })
  assert.deepEqual(registry.enabled().map(module => module.id), ['queue'])
  registry.setAll(false)
  assert.equal(registry.enabled().length, 0)
  registry.setAll(true)
  assert.equal(registry.enabled().length, 2)
})

test('the workbench mounts the metrics layout engine with its own keys', () => {
  const view = read('src/views/research.js')
  assert.match(view, /storageKey: 'mc\.research\.layout'/, 'the arrangement key left the plan')
  assert.match(view, /createResearchRegistry\(/, 'the registry is not wired')
  for (const id of ['designer', 'runboard', 'results', 'tiers', 'queue', 'library', 'methods', 'worklists']) {
    assert.match(view, new RegExp(`data-mc="${id}"`), `module ${id} lost its engine hook`)
  }
  assert.match(view, /data-modules-btn/, 'the Modules button is gone')
  assert.match(view, /registry\.setAll\(true\)/, 'the all-on control is unwired')
  assert.match(view, /registry\.setAll\(false\)/, 'the all-off control is unwired')
  /* The engine's component hook is data-mc — hard-coded in its drop
     targeting — so the workbench must use it, not a research-only name. */
  const engine = read('src/metrics-layout.js')
  assert.match(engine, /closest\('\[data-mc\]'\)/, 'the engine hook moved; update the workbench sections with it')
})

/* RE-AIMED with the source-axis cutover. This clause used to anchor
   isLiveView('research') and the per-view flag's register rows — the exact
   machinery the owner's ruling ("all simulated pages ARE the UI pages, just
   mock data") removed. What it guards now is the ruling itself: ONE render
   path whose inputs come from the one source axis (src/data-source.js), a
   mock verdict that is badged as the example, and a page that re-resolves
   when the host says the world changed instead of trusting a stale verdict.
   The old clauses that read live-flags.js and quick-settings.js are gone on
   purpose: those files are the dying machinery, and a research suite pinning
   their contents would turn red the moment the cutover finishes them. */
test('the sample face is the one render fed mock data from the source axis', () => {
  const view = read('src/views/research.js')
  assert.match(view, /resolveDataSource\(/, 'the page no longer resolves the one source axis')
  assert.match(view, /DATA_SOURCE_EVENT/, 'the page no longer re-resolves when the host announces a source change')
  assert.match(view, /sourceIsBadged\(/, 'the badge rule stopped being read from its one home in data-source.js')
  assert.match(view, /example data/, 'the mock mast no longer says it is an example')
  assert.match(view, /never saves, starts, or removes/, 'the example lost its write refusal — mock must never write')
  /* Comments stripped first, as the R198 guard below does: the view's own WHY
     prose is allowed to NAME the machinery it replaced — that is how house
     comments record history — but no surviving CODE may read it. */
  const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /isLiveView|setLiveView|live-flags/,
    'the per-view live flag is back in the research view; the source axis replaced it')
})

test('the R198 locked-report branch still reads only title and reason', () => {
  const view = read('src/views/research.js')
  const start = view.indexOf('function lockedReportMarkup')
  /* Comments stripped first: the branch's own R198 note NAMES the forbidden
     fields, and a guard that trips on the warning label guards nothing. */
  const branch = view.slice(start, view.indexOf('function safeReportMarkup'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(branch.length > 100, 'the locked branch left the view')
  /* Field READS, not substrings: the lock icon's <path> element and other
     markup words must not trip a guard about payload access. */
  for (const field of ['summary', 'bytes', 'dateObserved', 'path']) {
    const reads = new RegExp(`report\\??\\.${field}\\b|\\[(?:'|")${field}(?:'|")\\]`)
    assert.ok(!reads.test(branch), `the locked branch grew a read of ${field}`)
  }
  assert.match(branch, /report\?\.title/, 'the guard lost its anchor on the branch that reads title')
})

test('the engine chrome css moved with the engine, not copied per page', () => {
  const engineCss = read('src/metrics-layout.css')
  assert.match(engineCss, /\.m-tray \{ display: none; \}/, 'the tray base rule left the engine css')
  assert.match(engineCss, /\.m-editing \.m-tray/, 'edit-state chrome must scope on .m-editing, the class the engine toggles')
  assert.ok(!engineCss.includes('.metrics.m-editing'), 'engine chrome css is scoped to the metrics page again')
  const engine = read('src/metrics-layout.js')
  assert.match(engine, /import '\.\/metrics-layout\.css'/, 'the engine no longer carries its own chrome')
  const metricsCss = read('src/metrics.css')
  assert.ok(!metricsCss.includes('.m-tray {'), 'metrics.css still owns a copy of the tray chrome')

  const researchCss = read('src/research.css')
  assert.match(researchCss, /\.research-modules \.m-tray \{ margin-top: 0; \}/,
    'the research page lost the zero-margin tray repair')
})

test('appearance persistence settles the finite tray animation before strict geometry measurement', () => {
  const source = read('tools/appearance-persistence-drive.mjs')
  const probeStart = source.indexOf('const geometry = await window.evaluate')
  const probeEnd = source.indexOf('note(`geometry:', probeStart)
  const probe = source.slice(probeStart, probeEnd)
  const animationsAt = probe.indexOf("const tray = document.querySelector('.m-tray')")
  const finiteAt = probe.indexOf('Number.isFinite(timing?.endTime)', animationsAt)
  const finishAt = probe.indexOf('animation.finish()', finiteAt)
  const rectAt = probe.indexOf('getBoundingClientRect()', finishAt)

  assert.ok(probeStart >= 0 && probeEnd > probeStart, 'the appearance geometry probe left the driver')
  assert.ok(animationsAt >= 0 && finiteAt > animationsAt && finishAt > finiteAt && rectAt > finishAt,
    'the driver must settle only finite tray animations before collecting strict geometry')
})
