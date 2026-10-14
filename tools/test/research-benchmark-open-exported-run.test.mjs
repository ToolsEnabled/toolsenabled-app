import { useArithmeticExample } from './lib/benchmark-example.mjs'
// Re-opening a completed run in the Research page (owner ask A14, answer B).
//
// Opening an exported archive puts its frozen project in the page. This file proves
// the rest of what the owner asked for: the run's own evidence is admitted, the run
// can be inspected in place, and its report is reproduced in the page. For an archive
// this build can rebuild, the page's report is byte-identical to what the exported
// runner's `node cli.mjs analyze` writes. That runner is executed here as child
// processes, replay-only (recorded responses, no provider, no LEAN, no network): it is
// the reproduction oracle the owner runs by hand, not something the page does. The
// page itself never executes archive code; it only reads the archive's text. For an
// archive some other build froze, the report is rendered through the archive's own
// integrity, without a rebuild that would refuse it, and says so; the page carries
// the archive's own manifest, provenance and attributions into that report exactly as
// the runner reads them beside the project.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { unzipFiles } from '../../src/benchmark/archive.mjs'
import { zipFiles } from '../../src/benchmark/export.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder, runtimeIntegrityFor } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
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

// A ZIP the page exported, and the project inside it. The purpose is one whose
// collection admission passes, so its evidence can be imported at all.
async function exportedArchive() {
  const view = await mount()
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

// The same archive as another build would have frozen it: internally consistent, and
// not rebuildable here. The readiness digest is untouched, so a journal recorded
// against the original still binds to it; only the compiled blockers moved, which is
// the kind of change that re-identifies every earlier frozen project.
async function resealed(files, mutate) {
  const { sha256: _previous, ...body } = JSON.parse(files['project.json'])
  mutate(body)
  const project = { ...body, sha256: await sha256(canonical(body)) }
  const next = { ...files, 'project.json': JSON.stringify(project, null, 2) + '\n' }
  const manifest = JSON.parse(next['manifest.json']), digests = {}
  for (const name of Object.keys(manifest.files)) digests[name] = await sha256(next[name])
  next['manifest.json'] = canonical({ format: 'research-benchmark-files', version: 1, projectSha256: project.sha256, files: digests }) + '\n'
  return { bytes: zipFiles(next), files: next, project }
}
const foreignRuntime = files => resealed(files, body => {
  body.readiness = { ...body.readiness, blockers: [{ code: 'fixture-recorded-elsewhere', path: 'protocol.grading.kind', message: 'Recorded by a build whose readiness output differed.' }] }
})

// A journal the original runtime recorded for this project, as the exported runner
// would have written it into results/evidence.json.
async function recordedEvidence(archive, project = archive.project) {
  const { events } = await runStudy(archive.project)
  return JSON.stringify({ projectSha256: project.sha256, events: events.map(event => ({ ...event, projectSha256: project.sha256 })) })
}
// report.md escapes Markdown punctuation; undo that before searching it for a field name.
const unescapeMarkdown = text => text.replace(/\\(.)/g, '$1')
// The DOM stand-in joins block elements without whitespace, so read each block on its own.
const blockTexts = node => ['h3', 'h4', 'p', 'li'].flatMap(tag => Array.from(node.querySelectorAll(tag))).map(item => item.textContent)

beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('a run re-opened read-only admits its own evidence and shows its walkthrough in place', async () => {
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const evidence = await recordedEvidence(archive, foreign.project)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  assert.match(details(view), /read-only/i)
  await feedText(view, 'import-evidence', evidence)
  assert.match(status(view), /Evidence imported/)
  const results = field(view, 'results')
  assert.ok(results.querySelector('[data-bench-run-inspection]'), 'the run walkthrough is rendered')
  assert.equal(results.querySelector('[data-bench-run-inspection-error]'), null, 'and not an error in its place')
  assert.equal(field(view, 'export-report').disabled, false)
})

test('the report of a run re-opened read-only is rendered through the archive integrity, and says so', async () => {
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const evidence = await recordedEvidence(archive, foreign.project)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  await feedText(view, 'import-evidence', evidence)
  assert.match(status(view), /Evidence imported/)
  await click(view, 'export-report')
  const download = downloads.at(-1)
  assert.equal(download.name, foreign.project.spec.id + '-report.zip')
  const report = unzipFiles(download.contents)
  assert.match(report['report.html'], /Verified by archive integrity only/)
  assert.match(report['report.html'], /was NOT rebuilt/)
  assert.match(unescapeMarkdown(report['report.md']), /readiness\.blockers/, 'the compiled fields this build rebuilds differently are named')
  assert.equal(JSON.parse(report['execution-manifest.json']).projectSha256, foreign.project.sha256)
  // The archive's own manifest travelled into the report, not one this build regenerated.
  assert.equal(report['paper/manifest.json'], foreign.files['manifest.json'])
  // The opened path passes the page's runtime map too: this archive pins the runtime the page runs.
  assert.match(unescapeMarkdown(report['report.md']), /Runtime integrity: the running build's runtime matches the frozen project's pinned runtime \(\d+ files\)\./)
  assert.match(status(view), /report exported/i)
})

test('page and exported-runner report bytes agree for a run re-opened from its own archive', async t => {
  const archive = await exportedArchive()
  const root = await mkdtemp(resolve(tmpdir(), 'w20-open-exported-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(archive.files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  // The real exported runner as the owner runs it, replay-only: verify, run, analyze.
  const cli = command => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true })
  for (const command of ['verify', 'run', 'analyze']) { const result = cli(command); assert.equal(result.status, 0, command + ': ' + result.stderr + result.stdout) }
  const evidence = await readFile(resolve(root, 'results', 'evidence.json'), 'utf8')
  assert.equal(JSON.parse(evidence).projectSha256, archive.project.sha256)

  const view = await mount()
  await feed(view, 'open-exported', archive.bytes)
  assert.match(details(view), /verified/i)
  assert.doesNotMatch(details(view), /read-only/i)
  await feedText(view, 'import-evidence', evidence)
  assert.match(status(view), /Evidence imported/)
  await click(view, 'export-report')
  const download = downloads.at(-1)
  assert.equal(download.name, archive.project.spec.id + '-report.zip')
  const page = unzipFiles(download.contents), names = Object.keys(page).sort()
  assert.ok(names.length > 10 && names.includes('report.md') && names.includes('report.html') && names.includes('paper/manifest.json'), names.join(', '))
  for (const name of names) {
    const runner = await readFile(resolve(root, 'results', name))
    assert.ok(Buffer.from(page[name], 'utf8').equals(runner), name + ' differs between the page and node cli.mjs analyze')
  }
  assert.equal(page['paper/manifest.json'], archive.files['manifest.json'])
})

test('leaving and returning to the project keeps a read-only opened project read-only', async () => {
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const evidence = await recordedEvidence(archive, foreign.project)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  assert.match(details(view), /read-only/i)
  await view.setContext(B, 'live'); await idle(view)
  await view.setContext(A, 'live'); await idle(view)
  assert.ok(field(view, 'frozen').textContent.includes(foreign.project.sha256), 'the opened project is restored')
  assert.match(details(view), /read-only/i, 'and it is still read-only')
  assert.equal(field(view, 'run').disabled, true)
  assert.match(field(view, 'handoff').textContent, /read-only|rebuild/i)
  await feedText(view, 'import-evidence', evidence)
  assert.match(status(view), /Evidence imported/)
})

test('the handoff does not claim the exported runner shares this build\'s readiness verdict for a read-only opened project', async () => {
  // This build read the requirements with its own runtime; the runner inside the
  // archive applies the readiness it was frozen with, which can differ.
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  const handoff = field(view, 'handoff').textContent
  assert.match(handoff, /read-only/)
  assert.ok(!handoff.includes('applies these same execution requirements'), handoff)
  assert.match(handoff, /readiness it was frozen with/)
})

test('a run made on the page declares the renderer runtime it ran on, in the journal and the report', async () => {
  // The exported runner records Node's process facts in each started event; the page
  // records what the renderer exposes to it, its user agent and platform, so a page-run
  // report no longer says "Runtime versions: Not declared". Nothing is invented.
  const view = await mount()
  const purpose = field(view, 'execution-purpose')
  purpose.value = 'recorded-diagnostic'; purpose.dispatch('input')
  await click(view, 'apply-execution')
  await click(view, 'freeze')
  await click(view, 'run')
  assert.match(status(view), /run finished|completed/i, status(view))
  await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  const started = evidence.events.filter(event => event.type === 'started')
  assert.ok(started.length > 0)
  for (const event of started) {
    assert.equal(event.runtime?.host, 'research-page', 'every started event names the page as its host')
    assert.equal(event.runtime.userAgent, globalThis.navigator.userAgent)
  }
  await click(view, 'export-report')
  const report = unzipFiles(downloads.at(-1).contents)
  assert.match(unescapeMarkdown(report['report.md']), /Runtime versions[^\n]*research-page/)
  assert.doesNotMatch(unescapeMarkdown(report['report.md']), /Runtime versions[^\n]*Not declared/)
  // The live path passes the page's runtime map: a project frozen here matches every pin.
  assert.match(unescapeMarkdown(report['report.md']), /Runtime integrity: the running build's runtime matches the frozen project's pinned runtime \(\d+ files\)\./)
})

test('the page answers the report with the digest of its own bundled source for every pinned runtime file', async () => {
  // Manager finding F4, report.mjs contract (431cdec3): a map file -> running digest, null
  // when this build bundles no such file; the report compares it with the project's pins.
  const archive = await exportedArchive()
  assert.equal(typeof runtimeIntegrityFor, 'function')
  const running = await runtimeIntegrityFor(archive.project, sources)
  assert.deepEqual(running, archive.project.spec.runtimeSources, 'a project frozen here pins exactly the digests this build runs')
  const missing = await runtimeIntegrityFor(archive.project, { ...sources, 'report.mjs': undefined })
  assert.equal(missing['report.mjs'], null, 'a file this build does not bundle is null, never a guessed digest')
})

test('the map answers against the project\'s own pins, and the report names a pinned file this build does not match', async () => {
  const archive = await exportedArchive()
  const altered = await resealed(archive.files, body => { body.spec.runtimeSources['report.mjs'] = 'f'.repeat(64) })
  const running = await runtimeIntegrityFor(altered.project, sources)
  assert.equal(running['report.mjs'], await sha256(sources['report.mjs']), 'the running digest is the page bundle, not the pin')
  const events = JSON.parse(await recordedEvidence(archive, altered.project)).events
  const files = await researchReportFiles(altered.project, events, { runtimeIntegrity: running,
    archiveIntegrity: { files: 1, rebuildDiffering: ['spec.runtimeSources.report.mjs'], runtimeDiffering: ['report.mjs'] } })
  assert.match(unescapeMarkdown(files['report.md']), new RegExp("Runtime integrity: the running build's runtime differs from the frozen project's pinned runtime in 1 file: report\\.mjs " + 'f'.repeat(64) + ' -> ' + running['report.mjs']))
})

test('the readiness panel says whose reading it shows for a read-only opened project, and only then', async () => {
  const archive = await exportedArchive()
  const local = await mount()
  const purpose = field(local, 'execution-purpose')
  purpose.value = 'recorded-diagnostic'; purpose.dispatch('input')
  await click(local, 'apply-execution')
  await click(local, 'freeze')
  assert.equal(field(local, 'readiness').querySelector('[data-bench-readiness-foreign]'), null, 'a page-frozen project shows no such sentence')
  const foreign = await foreignRuntime(archive.files)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  const note = field(view, 'readiness').querySelector('[data-bench-readiness-foreign]')
  assert.ok(note, 'a read-only opened project names whose reading the panel shows')
  assert.match(note.textContent, /with its own runtime/)
  assert.match(note.textContent, /do not say whether the exported runner inside the archive is ready/)
})

test('the handoff and the import refusal name the ZIP that Export runnable ZIP downloads', async () => {
  // HT-6 (root's rehearsal): both used to say "standalone-project.zip", which the page never writes.
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  const handoff = field(view, 'handoff').textContent
  assert.ok(handoff.includes(foreign.project.spec.id + '.zip'), handoff)
  assert.ok(!handoff.includes('standalone-project.zip'), handoff)
  const other = await mount()
  const purpose = field(other, 'execution-purpose')
  purpose.value = 'recorded-diagnostic'; purpose.dispatch('input')
  await click(other, 'apply-execution')
  await click(other, 'freeze')
  await feedText(other, 'import-evidence', await recordedEvidence(archive, foreign.project))
  assert.match(status(other), /This evidence belongs to a different frozen project/)
  assert.match(status(other), /the <identifier>\.zip that Export runnable ZIP downloaded/)
  assert.ok(!status(other).includes('standalone-project.zip'), status(other))
  assert.match(status(other), /cli\.mjs/, "Worker 9's working path stays named")
})

test('Export evidence and Export results CSV write a status line naming the file', async () => {
  // HT-7 (root's rehearsal): these exports downloaded silently while every other export wrote a line.
  const view = await mount()
  const purpose = field(view, 'execution-purpose')
  purpose.value = 'recorded-diagnostic'; purpose.dispatch('input')
  await click(view, 'apply-execution')
  await click(view, 'freeze')
  await click(view, 'run')
  const id = field(view, 'id').value
  await click(view, 'export-evidence')
  assert.equal(downloads.at(-1).name, id + '-evidence.json')
  assert.equal(status(view), 'Evidence exported as ' + id + '-evidence.json.')
  await click(view, 'export-csv')
  assert.equal(downloads.at(-1).name, id + '-results.csv')
  assert.equal(status(view), 'Results CSV exported as ' + id + '-results.csv.')
})

test('the page strings this lane owns keep every sentence within the plain-language limit', async () => {
  // The npm test preamble's plain-language gate (tools/check-plain-language.mjs) refuses any
  // sentence over 25 words and forbids baselining new ones; this pins the sentences this lane
  // added or rewrote, as rendered, so a later edit cannot quietly cross the line.
  const archive = await exportedArchive()
  const foreign = await foreignRuntime(archive.files)
  const view = await mount()
  await feed(view, 'open-exported', foreign.bytes)
  const rendered = [...blockTexts(field(view, 'frozen-details')), ...blockTexts(field(view, 'handoff')), field(view, 'readiness').querySelector('[data-bench-readiness-foreign]').textContent]
  await feedText(view, 'import-evidence', await recordedEvidence(archive, foreign.project))
  rendered.push(field(view, 'results').querySelector('[data-bench-run-inspection]').querySelector('p').textContent)
  for (const block of rendered) for (const sentence of block.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean).length
    assert.ok(words <= 25, words + ' words: ' + sentence.slice(0, 120))
  }
})
