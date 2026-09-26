import { useArithmeticExample } from './lib/benchmark-example.mjs'
// Opening an exported project in the page.
//
// Until now the page's frozen project could only be set by its own Freeze or by
// the in-session cache, so a completed run could never be re-opened: Import
// draft clears the frozen project, and Import run evidence refuses anything
// whose project digest is not the page's own freeze. That made the exported
// command-line runner the only route to reproduce a finished study, and made
// page-versus-runner report parity unmeasurable for any real run.
//
// Opening is not the same as freezing. A project this build can rebuild is
// admitted fully verified. One frozen by a different build is admitted
// READ-ONLY, with the compiled members that differ named, never the old generic
// sentence. No code from the archive is ever executed.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { unzipFiles } from '../../src/benchmark/archive.mjs'
import { zipFiles } from '../../src/benchmark/export.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads

const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
const details = view => field(view, 'frozen-details').textContent
async function idle(view) {
  for (let index = 0; index < 1000; index++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('The page did not settle: ' + status(view))
}
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
const memoryAccount = () => {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount() {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); await useArithmeticExample(view); return view
}
async function feed(view, name, bytes) {
  const node = field(view, name); assert.ok(node, name)
  const copy = bytes.slice()
  node.files = [{ size: copy.byteLength, arrayBuffer: async () => copy.buffer }]
  node.dispatch('change'); await idle(view)
}
async function feedText(view, name, contents) {
  const node = field(view, name); assert.ok(node, name)
  node.files = [{ size: contents.length, text: async () => contents }]
  node.dispatch('change'); await idle(view)
}

// A ZIP the page exported, and the project inside it.
async function exportedArchive() {
  const view = await mount()
  // A purpose whose collection admission passes, so evidence for it can be
  // imported at all; an experiment draft is refused for unrelated reasons.
  const purpose = field(view, 'execution-purpose')
  purpose.value = 'recorded-diagnostic'; purpose.dispatch('input')
  await click(view, 'apply-execution')
  await click(view, 'freeze')
  await click(view, 'export')
  const bytes = downloads.at(-1).contents
  assert.ok(bytes.byteLength > 0, 'the page exported an archive')
  const files = unzipFiles(bytes)
  return { bytes, files, project: JSON.parse(files['project.json']) }
}

// The same archive as another build would have frozen it: internally consistent,
// and not rebuildable here.
async function resealed(files, mutate) {
  const { sha256: _previous, ...body } = JSON.parse(files['project.json'])
  mutate(body)
  const project = { ...body, sha256: await sha256(canonical(body)) }
  const next = { ...files, 'project.json': JSON.stringify(project, null, 2) + '\n' }
  const manifest = JSON.parse(next['manifest.json']), digests = {}
  for (const name of Object.keys(manifest.files)) digests[name] = await sha256(next[name])
  next['manifest.json'] = canonical({ format: 'research-benchmark-files', version: 1, projectSha256: project.sha256, files: digests }) + '\n'
  return { bytes: zipFiles(next), project }
}
const foreignRuntime = files => resealed(files, body => {
  body.readiness = { ...body.readiness, blockers: [{ code: 'fixture-recorded-elsewhere', path: 'protocol.grading.kind', message: 'Recorded by a build whose readiness output differed.' }] }
})

beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('a fresh page opens an exported project it never froze, and names it', async () => {
  const archive = await exportedArchive()
  const view = await mount()
  await feed(view, 'open-exported', archive.bytes)
  assert.match(status(view), /opened/i)
  assert.ok(field(view, 'frozen').textContent.includes(archive.project.sha256), 'the page names the opened project digest')
})

test('an export this build can rebuild is admitted fully verified', async () => {
  const archive = await exportedArchive()
  const view = await mount()
  await feed(view, 'open-exported', archive.bytes)
  assert.match(details(view), /verified/i)
  assert.doesNotMatch(details(view), /read-only/i)
})

test('an export frozen by another build is admitted read-only and names what differs', async () => {
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  assert.match(status(view), /opened/i, 'it is opened, not refused')
  assert.match(details(view), /read-only/i)
  assert.match(details(view), /readiness\.blockers/, 'the differing compiled members are named')
  assert.doesNotMatch(details(view), /belongs to a different frozen project/)
})

test('a read-only opened project cannot be run, and the page says why', async () => {
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  assert.equal(field(view, 'run').disabled, true)
  // The handoff panel is the single place that explains a refusal; this lane adds
  // its reason to that list rather than painting a second one.
  assert.match(field(view, 'handoff').textContent, /read-only|rebuild/i)
})

test('a tampered archive is refused, and the file at fault is named', async () => {
  const archive = await exportedArchive()
  const tampered = zipFiles({ ...archive.files, 'README.md': archive.files['README.md'] + 'an added line\n' })
  const view = await mount()
  await feed(view, 'open-exported', tampered)
  assert.match(status(view), /README\.md/)
  assert.equal(field(view, 'frozen').textContent.includes(archive.project.sha256), false, 'nothing was opened')
})

test('the opened project admits its own run evidence, which is the whole point', async () => {
  const archive = await exportedArchive()
  const { events } = await runStudy(archive.project)
  const evidence = JSON.stringify({ projectSha256: archive.project.sha256, events })
  const view = await mount()
  await feed(view, 'open-exported', archive.bytes)
  await feedText(view, 'import-evidence', evidence)
  assert.match(status(view), /Evidence imported/)
})
