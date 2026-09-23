import { useArithmeticExample } from './lib/benchmark-example.mjs'
// The Research page sentences the hand-test protocol reads back, pinned as bytes.
//
// The .44 hand test (HAND-TEST.md sections A and B) is the release gate for this
// page, and a step of it is only meaningful if the sentence it tells a person to
// read is the sentence the page writes. A rehearsal of that protocol measured
// which of those sentences any test asserts: fourteen were asserted by none, so
// every one of them could be reworded, softened or deleted and the whole suite
// would still pass. Four more belong to surfaces merged from the RP1, RP6 and
// RP7 lanes, whose own tests match them only by loose regular expression
// (/opened/i, /read-only/i), which a rewrite also survives.
//
// These tests assert the exact visible text, by equality or by whole-sentence
// inclusion, never by a word. A sentence that changes must change here too, in a
// commit that says so, which is what makes the hand test repeatable.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { approveBundle, canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { unzipFiles } from '../../src/benchmark/archive.mjs'
import { zipFiles } from '../../src/benchmark/export.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36)
const views = []
let installed, cryptoDescriptor, downloads

const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const message = view => f(view, 'status').textContent
async function idle(view) {
  for (let i = 0; i < 600; i++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('the benchmark UI did not settle: ' + message(view))
}
function fill(view, name, value) {
  const input = f(view, name); assert.ok(input, name); input.value = value; input.dispatch('input')
}
async function click(view, name) {
  const button = f(view, name); assert.ok(button, name)
  assert.equal(button.disabled, false, `${name} is available: ${message(view)}`)
  button.click(); await idle(view)
}
// Rendered panels only. The DOM stand-in inserts no space around an inline <code>
// element and does not decode &amp;, so "open <code>x.zip</code> with" arrives as
// "openx.zipwith". Spacing is the browser journey's to prove (TEST-MATRIX section E,
// HAND-TEST D4); what this file pins is the words and their order, so both sides are
// compared with every space removed and &amp; decoded. Plain status lines are single
// text nodes and are compared whole, with assert.equal, above.
const reads = text => String(text).replace(/&amp;/g, '&').replace(/\s+/g, '')
// A person can always reach a disabled-looking control in the packaged shell;
// the refusal, not the disabled attribute, is what this file pins.
async function press(view, name) { const button = f(view, name); assert.ok(button, name); button.click(); await idle(view) }
const memoryAccount = () => {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(options = {}) {
  const view = createBenchmarkBuilder({ account: memoryAccount(), loadSources: async () => sources,
    download: (name, contents) => downloads.push({ name, contents }), ...options })
  // A browser's input.value is always a string; the DOM stand-in stores whatever was
  // assigned, so a number field holds a Number and the page's own numeric check calls
  // .trim() on it. Mirror the browser, as research-benchmark-condition-freeze.test.mjs:47 does.
  for (const name of ['seed', 'replicates', 'attempts', 'total', 'timeout', 'duration']) {
    const node = f(view, name); let value = String(node.value)
    Object.defineProperty(node, 'value', { configurable: true, get: () => value, set: next => { value = String(next) } })
  }
  views.push(view); document.body.append(view.el)
  await view.setContext(A, options.source || 'live'); await idle(view)
  await useArithmeticExample(view)
  return view
}
async function importDraft(view, spec) {
  const contents = JSON.stringify({ spec })
  f(view, 'import').files = [{ size: contents.length, text: async () => contents }]
  f(view, 'import').dispatch('change'); await idle(view)
}
async function feedText(view, name, contents) {
  const node = f(view, name); assert.ok(node, name)
  node.files = [{ size: contents.length, text: async () => contents }]
  node.dispatch('change'); await idle(view)
}
// The shipped Lean starter with every bundle personally reviewed, so a freeze
// reaches the checks these tests are about instead of stopping at the review gate.
async function reviewedLean() {
  const spec = await bindLeanReview(leanStarter(), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle =>
    approveBundle(bundle, 'SYNTHETIC HAND-TEST STRING PIN — NOT A PERSON, NOT A REVIEW', undefined, { catalog: spec.catalog })))
  return spec
}
// HAND-TEST A7.1. The shipped Lean starter grades `json` with an empty leanImage
// (lean.mjs:60-61); connecting LEAN is the step the protocol tells a person to do,
// and it is what makes the page refuse to run the project itself.
const LEAN_DIGEST = 'quantconnect/lean@sha256:' + 'c'.repeat(64)
async function connectLean(view, leanImage) {
  fill(view, 'grading', 'lean-python')
  fill(view, 'environment', JSON.stringify({ ...JSON.parse(f(view, 'environment').value), leanImage }))
  fill(view, 'timeout', '900')
  await press(view, 'apply-protocol')
}
async function frozenLean(view) {
  await importDraft(view, await reviewedLean())
  await connectLean(view, LEAN_DIGEST)
  await click(view, 'freeze')
  return view
}
async function recordedDiagnostic(view) { fill(view, 'execution-purpose', 'recorded-diagnostic'); await click(view, 'apply-execution') }

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

// ---- HAND-TEST A2.1: the owner's own first input, "name .44 as the version" ----
test('A2.1 a dotted identifier is refused with the exact sentence the protocol reads', async () => {
  const view = await mount()
  await importDraft(view, await reviewedLean())
  fill(view, 'name', 'Lean Bench 1.0.44')
  fill(view, 'id', 'lean-bench-1.0.44')
  await press(view, 'freeze')
  // Re-pinned for T2. The old sentence refused every bad identifier the same
  // way and never said the dots were the reason; the page now names the dot,
  // offers the hyphenated slug, and sends the dotted number to Study version.
  assert.equal(message(view), 'An identifier cannot contain a dot, so lean-bench-1.0.44 is refused. Write lean-bench-1-0-44 instead. A dotted number belongs in Study version, which is where 1.0.44 goes.')
  assert.equal(f(view, 'id').value, 'lean-bench-1.0.44', 'the refused identifier is still in the editor')
})

// ---- HAND-TEST 0.3 and D1: what a preview refuses ----
test('0.3 example mode names itself as a preview and refuses account saves', async () => {
  const view = await mount({ source: 'mock' })
  assert.equal(f(view, 'save').disabled, true)
  assert.match(f(view, 'save').title, /Connect your account to save here/)
  assert.equal(downloads.length, 0, 'a preview writes no file')
})

// ---- HAND-TEST A5: personal review records ----
test('A5.2 an empty reviewer name is refused by name, and A5.4 a bundle edit says the review may no longer hold', async () => {
  const view = await mount()
  fill(view, 'reviewer', '   ')
  await press(view, 'approve')
  assert.equal(message(view), 'Enter the name of the person reviewing this exact bundle.')
  await click(view, 'apply-bundle')
  assert.equal(message(view), 'Snippet updated in this benchmark. Its previous review applies only if the exact content still matches.')
})

// ---- HAND-TEST A6.1: condition fields ----
test('A6.1 preparing condition fields says what to fill and that results are unchanged', async () => {
  const view = await mount()
  await importDraft(view, await reviewedLean())
  await click(view, 'prepare-condition-fields')
  assert.equal(message(view), 'Condition fields prepared from the current setup. Fill requested identities, typed settings and explicit response checks; current results are unchanged.')
})

// ---- HAND-TEST A7.2: the LEAN image pin ----
test('A7.2 a floating LEAN image tag is refused, and the refusal names the field and the digest form', async () => {
  const view = await mount()
  await importDraft(view, await reviewedLean())
  await connectLean(view, 'quantconnect/lean:latest')
  assert.equal(message(view), 'Pin the LEAN Docker image by SHA-256 digest in environment.leanImage before freezing code grading.')
})

// ---- HAND-TEST A9.1: the unreviewed-bundle refusal ----
test('A9.1 freezing an unreviewed apparatus names the bundle and what a review covers', async () => {
  const view = await mount()
  const spec = await bindLeanReview(leanStarter(), sources)
  await importDraft(view, spec)
  await press(view, 'freeze')
  assert.match(message(view), /^[a-z0-9-]+ needs review of its current wording, semantics, code and tests\.$/)
  const named = message(view).split(' ')[0]
  assert.ok(spec.catalog.some(bundle => bundle.id === named), `${named} is a bundle in this catalog`)
})

// ---- HAND-TEST A12: drafts ----
test('A12.2 an exported draft says it carries unapplied text, and A12.3 saving without an account says where else to put it', async () => {
  const view = await mount()
  await click(view, 'draft-export')
  assert.equal(message(view), 'Draft exported, including unapplied editor text.')
  assert.equal(downloads.at(-1).name, `${f(view, 'id').value}-draft.json`)
  const readOnly = await mount({ account: { async getSetting() { return { ok: true, value: null } } } })
  assert.equal(f(readOnly, 'save').disabled, true)
  assert.match(f(readOnly, 'save').title, /Connect your account to save here/)
})

test('A12.4 an oversized draft file is refused with its limit, before the file is read', async () => {
  const view = await mount()
  let read = false
  const node = f(view, 'import')
  node.files = [{ size: 128 * 1024 * 1024 + 1, text: async () => { read = true; return '{}' } }]
  node.dispatch('change'); await idle(view)
  assert.equal(message(view), 'Draft files are limited to 128 MiB.')
  assert.equal(read, false, 'the refusal comes before the file is read')
})

// ---- HAND-TEST A14.3: the report the owner reads ----
test('A14.3 the exported report names both things it was built from', async () => {
  const view = await mount()
  await recordedDiagnostic(view)
  await click(view, 'freeze')
  await click(view, 'run')
  await click(view, 'export-report')
  assert.equal(message(view), 'Research report exported from the frozen project and retained attempt journal.')
  assert.equal(downloads.at(-1).name, `${f(view, 'id').value}-report.zip`)
})

// ---- HAND-TEST A15.3 and A16.1: imports that cannot be admitted ----
test('A15.3 importing evidence before a freeze says which project must be frozen first', async () => {
  const view = await mount()
  await feedText(view, 'import-evidence', JSON.stringify({ projectSha256: '0'.repeat(64), events: [] }))
  assert.equal(message(view), 'Freeze the matching project before importing evidence.')
})

test('A16.1 native evidence from another frozen project is refused, and the refusal says so', async () => {
  const view = await frozenLean(await mount())
  assert.equal(f(view, 'import-native-evidence').disabled, false, 'lean-python offers native verification')
  await feedText(view, 'import-native-evidence', JSON.stringify({
    format: 'benchmark-native-evidence', version: 1, project: { sha256: '0'.repeat(64) }, events: [], files: {} }))
  assert.equal(message(view), 'This native evidence belongs to a different frozen project.')
})

// ---- HAND-TEST A18.1: the run board ----
test('A18.1 a submitted exported project says where to inspect it', async () => {
  const submitted = []
  const view = await frozenLean(await mount({ submitExported: async request => { submitted.push(request) } }))
  fill(view, 'directory', '/tmp/synthetic-hand-test-extract')
  await press(view, 'submit')
  assert.equal(message(view), 'Exported project submitted. Inspect its process and collected summary on the run board.')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].directory, '/tmp/synthetic-hand-test-extract')
})

// ---- Surfaces merged from the RP lanes, whose own tests match them loosely ----
// A ZIP this build exported, and the same archive as a build whose readiness
// output differed would have sealed it.
async function exportedArchive() {
  const view = await mount()
  await recordedDiagnostic(view)
  await click(view, 'freeze')
  await click(view, 'export')
  const bytes = downloads.at(-1).contents
  const files = unzipFiles(bytes)
  return { bytes, files, project: JSON.parse(files['project.json']) }
}
async function foreignRuntime(files) {
  const { sha256: _recorded, ...body } = JSON.parse(files['project.json'])
  body.readiness = { ...body.readiness, blockers: [{ code: 'fixture-recorded-elsewhere', path: 'protocol.grading.kind', message: 'Recorded by a build whose readiness output differed.' }] }
  const project = { ...body, sha256: await sha256(canonical(body)) }
  const next = { ...files, 'project.json': JSON.stringify(project, null, 2) + '\n' }
  const manifest = JSON.parse(next['manifest.json']), digests = {}
  for (const name of Object.keys(manifest.files)) digests[name] = await sha256(next[name])
  next['manifest.json'] = canonical({ format: 'research-benchmark-files', version: 1, projectSha256: project.sha256, files: digests }) + '\n'
  return zipFiles(next)
}
async function feedBytes(view, name, bytes) {
  const node = f(view, name); assert.ok(node, name)
  const copy = bytes.slice()
  node.files = [{ size: copy.byteLength, arrayBuffer: async () => copy.buffer }]
  node.dispatch('change'); await idle(view)
}

test('A9.3 [RP7] the frozen inspection says what it reads and what it never shows', async () => {
  const view = await mount()
  await click(view, 'freeze')
  const text = f(view, 'frozen-inspection').textContent
  assert.ok(text.includes('What this frozen project will send and grade, read from the frozen specification itself. Saved replay responses and credential values are never shown here.'),
    'the frozen inspection states its source and its exclusions: ' + text.slice(0, 200))
  for (const caption of ['Protocol and apparatus', 'Conditions as frozen', 'Frozen schedule', 'Runtime pins'])
    assert.ok(text.includes(caption), caption)
})

test('A13.4 [RP7] the run journal names itself and its disposition table', async () => {
  const view = await mount()
  await recordedDiagnostic(view)
  await click(view, 'freeze')
  await click(view, 'run')
  const results = f(view, 'results').textContent
  assert.ok(results.includes('Run journal'), 'the run journal names itself')
  assert.ok(results.includes('Trial dispositions by condition'), 'the disposition table names itself')
})

test('A11 the handoff tells a person exactly how a finished run comes back to this page', async () => {
  const view = await frozenLean(await mount())
  const handoff = f(view, 'handoff').textContent
  // Stops before the ampersand of "Run & export": what a person reads there is
  // decided by HTML entity decoding, which is not what this test is about.
  // Re-pinned for WS2-2. The page never wrote standalone-project.zip; root's
  // rehearsal caught it, and Worker 20's HT-6 commit names the ZIP that Export
  // runnable ZIP actually downloads. The identifier is read back off the page
  // rather than typed in here, so this also pins that the sentence carries the
  // frozen study's own id and not some other string.
  const identifier = f(view, 'id').value
  assert.ok(identifier, 'the page shows the frozen identifier')
  assert.ok(reads(handoff).includes(reads(`Then bring the run back here. Open the exported ZIP, ${identifier}.zip as Export runnable ZIP downloads it, with Open exported project. Then import results/evidence.json with Import run evidence under Run & export, and results/native-evidence.json with Verify native evidence.`)),
    'the handoff names the ZIP the page writes and both imports, in order: ' + handoff.slice(-360))
  assert.ok(reads(handoff).includes(reads('Opening first is what lets this page hold the project the run belongs to.')),
    'the handoff says why opening comes first')
  for (const command of ['node cli.mjs verify', 'node cli.mjs qualify', 'node cli.mjs run', 'node cli.mjs verify-native', 'node cli.mjs analyze'])
    assert.ok(reads(handoff).includes(reads(command)), 'the handoff lists ' + command)
})

test('A17.1 and A17.2 [RP1] a verified open and a read-only open are told apart in full sentences', async () => {
  const archive = await exportedArchive()
  const verified = await mount()
  await feedBytes(verified, 'open-exported', archive.bytes)
  assert.ok(message(verified).startsWith('Project opened from its archive and verified: '),
    'a rebuildable archive opens verified: ' + message(verified))
  assert.ok(message(verified).endsWith(' files matched its manifest, and this build rebuilds it exactly. Import its run evidence to inspect the results here.'),
    'the verified sentence ends by saying what to do next: ' + message(verified))

  const foreign = await foreignRuntime(archive.files)
  const readOnly = await mount()
  await feedBytes(readOnly, 'open-exported', foreign)
  assert.ok(message(readOnly).startsWith('Project opened from its archive, read-only: '),
    'an archive this build rebuilds differently opens read-only: ' + message(readOnly))
  assert.ok(message(readOnly).includes(' files matched its manifest, but this build rebuilds it differently at '),
    'the read-only sentence names where the rebuild differs: ' + message(readOnly))
  assert.ok(message(readOnly).endsWith('. Its evidence and report can be inspected; it cannot be run here.'),
    'the read-only sentence says what remains possible: ' + message(readOnly))
  assert.equal(f(readOnly, 'run').disabled, true, 'a read-only project cannot be run here')
})
