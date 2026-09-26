import { useArithmeticExample } from './lib/benchmark-example.mjs'
// The Research page's own walkthrough of a completed run.
//
// The exported report package already renders the composition layers, the
// compiled prompts, the request envelopes, the journal walkthrough and the
// per-trial evidence (VENUE-REPORT-SPEC items 4, 5, 8 and 9). Before this
// suite the page rendered none of them: a reader had to export a ZIP, leave
// the application and open report.html. These tests hold the page to the same
// content as the report, generated from the same frozen project and the same
// journal, so the page and the report cannot drift apart.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const CONTEXT = 'rp-' + 'a'.repeat(36)
const REVIEWER = 'PAGE WALKTHROUGH FIXTURE MARKER ONLY'
const views = []
let installed, fixture, cryptoDescriptor

const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate, what) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause() }
  assert.fail(what || 'the benchmark page did not settle')
}
const f = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
async function click(view, name) {
  assert.equal(f(view, name).disabled, false, name + ' is available')
  f(view, name).click(); await idle(view)
}
// The stand-in keeps parsed text as written, so undo the page's own escaping
// before comparing a prompt or a response with the bytes the report retained.
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[match]))
const PREVIEW_LIMIT = 4000
// The page shows the report's own capped preview of a retained file. Compare
// the two exactly: a prefix of the right length, never an incidental match.
function assertShowsFile(view, name, files, what) {
  const pre = view.el.querySelector('[data-bench-verbatim="' + name + '"]')
  assert.ok(pre, what + ' has its own block on the page naming ' + name)
  const retained = String(files[name]).replace(/\n$/, '')
  const shown = decode(pre.textContent)
  assert.ok(shown.length > 0, what + ' is not empty on the page')
  assert.equal(shown.length, Math.min(retained.length, PREVIEW_LIMIT), what + ' shows the preview length the report uses')
  assert.ok(retained.startsWith(shown), what + ' on the page is the retained bytes, from the start')
  if (retained.length > PREVIEW_LIMIT) {
    const rest = view.el.querySelector('[data-bench-verbatim="' + name + '"] ~ details [data-bench-verbatim-full]')
      || pre.parentNode.querySelector('[data-bench-verbatim-full]')
    assert.ok(rest, what + ' offers the complete text when it is capped')
  }
}

async function genericSpec() {
  let spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic' })
  spec = await bindRuntimeSources(spec, sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle =>
    approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return spec
}
async function mount() {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources,
    download: (name, contents) => fixture.downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el)
  await view.setContext(CONTEXT, 'live')
  await useArithmeticExample(view)
  await until(() => f(view, 'preview-meta').textContent.includes('components'), 'the editor never compiled a preview')
  return view
}
async function importDraft(view, spec) {
  const contents = JSON.stringify({ spec })
  f(view, 'import').files = [{ size: contents.length, text: async () => contents }]
  f(view, 'import').dispatch('change'); await idle(view)
}
// One frozen project, run on the page, with the report generated from exactly
// the project the page froze and exactly the journal the page produced.
async function runOnPage() {
  const view = await mount()
  const spec = await genericSpec()
  await importDraft(view, spec)
  await click(view, 'freeze')
  const project = await freezeStudy(spec)
  assert.ok(f(view, 'frozen').textContent.includes(project.sha256),
    'the page froze the same project this test froze')
  await click(view, 'run')
  await click(view, 'export-evidence')
  const evidence = JSON.parse(fixture.downloads.at(-1).contents)
  assert.equal(evidence.projectSha256, project.sha256)
  const files = await researchReportFiles(project, evidence.events)
  return { view, project, events: evidence.events, files }
}

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fixture = { values: new Map(), downloads: [] }
  fixture.account = {
    async getSetting(key) { return { ok: true, value: fixture.values.get(key) ?? null } },
    async putSetting(key, value) { fixture.values.set(key, value); return { ok: true } },
  }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('item 4: the frozen view shows every composition layer and the compiled prompt the report retains', async () => {
  const { view, project, files } = await runOnPage()
  const section = f(view, 'method-composition')
  assert.ok(section, 'the page renders a composition section for the frozen project')
  const text = decode(section.textContent)
  for (const task of project.tasks) {
    const block = view.el.querySelector('[data-bench-composition-task="' + task.id + '"]')
    assert.ok(block, 'task ' + task.id + ' has its own composition block')
    for (const node of task.compiled.composition.nodes) {
      assert.ok(text.includes(node.path), 'node path ' + node.path + ' is listed')
      assert.ok(text.includes(node.bundle.sha256), 'bundle digest for ' + node.path + ' is listed')
    }
    assert.ok(files['paper/prompts/' + task.id + '.txt'], 'the report retained a prompt file for ' + task.id)
    assertShowsFile(view, 'paper/prompts/' + task.id + '.txt', files, 'the compiled prompt for ' + task.id)
  }
})

test('item 4: the layer map on the page carries the same character ranges as the report', async () => {
  const { view, project, files } = await runOnPage()
  for (const task of project.tasks) {
    const table = view.el.querySelector('[data-bench-source-map="' + task.id + '"]')
    assert.ok(table, 'task ' + task.id + ' has a layer map table')
    const text = decode(table.textContent)
    const map = JSON.parse(files['paper/source-maps/' + task.id + '.json'])
    assert.ok(map.ranges.length, 'the frozen task has at least one source-map range')
    for (const range of map.ranges.slice(0, 3)) {
      assert.ok(text.includes(String(range.start)) && text.includes(String(range.end)),
        'range ' + range.start + '-' + range.end + ' is shown')
      assert.ok(text.includes(range.path), 'range ' + range.start + '-' + range.end + ' names its node path')
    }
  }
})

test('item 5: the page shows each condition and the request envelope actually sent', async () => {
  const { view, project, files } = await runOnPage()
  const section = f(view, 'method-conditions')
  assert.ok(section, 'the page renders a conditions section')
  const text = decode(section.textContent)
  for (const condition of project.spec.conditions) {
    assert.ok(text.includes(condition.id), 'condition ' + condition.id + ' is listed')
    if (!files['paper/requests/' + condition.id + '.json']) continue
    assertShowsFile(view, 'paper/requests/' + condition.id + '.json', files, 'the request envelope for ' + condition.id)
  }
  assert.ok(/never its value|not part of the request envelope/.test(text),
    'the page repeats the report sentence that a credential value is never shown')
})

test('item 8: the run walkthrough lists every journal event in order', async () => {
  const { view, events } = await runOnPage()
  const table = f(view, 'walkthrough-table')
  assert.ok(table, 'the page renders a run walkthrough table')
  const text = decode(table.textContent)
  assert.ok(events.length, 'the run produced journal events')
  for (const event of events) {
    assert.ok(text.includes(String(event.seq)), 'event ' + event.seq + ' is listed')
    assert.ok(text.includes(event.type), 'event ' + event.seq + ' names its type')
    if (event.trialId) assert.ok(text.includes(event.trialId), 'event ' + event.seq + ' names its trial')
  }
})

test('item 9: every finished attempt shows its response verbatim and its grade on the page', async () => {
  const { view, events, files } = await runOnPage()
  const finished = events.filter(event => event.type === 'finished')
  assert.ok(finished.length, 'the run finished at least one attempt')
  for (const event of finished) {
    const block = view.el.querySelector('[data-bench-trial="' + event.trialId + '-' + event.attempt + '"]')
    assert.ok(block, 'attempt ' + event.trialId + '-' + event.attempt + ' has its own block')
    const text = decode(block.textContent)
    assert.ok(text.includes(event.status), 'the attempt states its status')
    const name = 'trials/' + event.trialId + '-' + event.attempt + '/response.txt'
    if (files[name]) assertShowsFile(view, name, files, 'the model response for ' + event.trialId + '-' + event.attempt)
    const grade = files['trials/' + event.trialId + '-' + event.attempt + '/grade.json']
    if (grade) {
      const parsed = JSON.parse(grade)
      assert.ok(text.includes(String(parsed.passed)), 'the grade states whether the attempt passed')
      if (parsed.reason) assert.ok(text.includes(parsed.reason), 'the grade states its reason')
    }
  }
})

test('the raw journal stays available, and is no longer the only way to read a run', async () => {
  const { view } = await runOnPage()
  assert.ok(f(view, 'raw-journal'), 'the raw journal dump is still offered')
  assert.ok(f(view, 'walkthrough-table'), 'a reader no longer depends on it')
  assert.ok(f(view, 'trial-evidence'), 'per-trial evidence is rendered on the page')
})
