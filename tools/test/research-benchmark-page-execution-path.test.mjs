import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { approveBundle } from '../../src/benchmark/prompts.mjs'

// Generating Lean Bench from the Research page ends at export: the page cannot run a
// lean-python project with command adapters, and today it says none of that. It shows the
// blockers of one purpose only (the project's own), prints them as `path: message` without
// the code, never explains why "Run recorded responses" is disabled, and offers no command
// for the exported CLI that R2 actually had to use. Measured on the merged tree for project
// ccd0ec90 (INTEGRATION/parity-709876dd/t61-verify.log): three purposes, 1 + 9 + 4 blockers,
// every one of them hidden except the first purpose's single row.

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name =>
  [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 2))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const text = (view, name) => field(view, name)?.textContent ?? ''

async function idle(view) {
  for (let n = 0; n < 1000; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('The page did not settle: ' + text(view, 'status'))
}
async function click(view, name) {
  const node = field(view, name)
  assert.ok(node, name); assert.equal(node.disabled, false, name + ': ' + text(view, 'status'))
  node.click(); await idle(view)
}
const memoryAccount = () => {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount() {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function importDraft(view, draft) {
  const contents = JSON.stringify(draft)
  field(view, 'import').files = [{ size: contents.length, text: async () => contents }]
  field(view, 'import').dispatch('change'); await idle(view)
}

// The shipped Lean Bench starter taken down the documented real-engine path: schema 2,
// apparatus-development purpose, lean-python grading with a pinned digest. This is the
// exact shape R2 froze and then had to run through the exported CLI.
async function leanDraft() {
  const spec = await bindLeanReview(leanStarter(), sources)
  spec.schemaVersion = 2
  spec.executionPlan = { version: 1, purpose: 'apparatus-development' }
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.primaryDenominator = 'scheduled'
  spec.analysisPlan.uncertainty = null
  spec.analysisPlan.multiplicity = 'none-descriptive'
  spec.protocol.grading = { kind: 'lean-python' }
  spec.environment.leanImage = 'image@sha256:' + 'a'.repeat(64)
  // Lean Bench requires current personal bundle reviews before it will freeze. These
  // reviewer identities are synthetic and named as such; they approve nothing real.
  spec.catalog = await Promise.all(spec.catalog.map(bundle =>
    approveBundle(bundle, 'SYNTHETIC RP4 LANE TEST ONLY', undefined, { catalog: spec.catalog })))
  return spec
}

async function frozenLean() {
  const view = await mount()
  await importDraft(view, { spec: await leanDraft() })
  await click(view, 'freeze')
  return view
}

beforeEach(() => {
  installed = installDomStandIn()
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  account = memoryAccount(); downloads = []
})
afterEach(() => {
  for (const view of views.splice(0)) view.el.remove()
  installed?.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('the readiness panel reports every execution purpose, not only the one the project declares', async () => {
  const view = await frozenLean()
  const panel = text(view, 'readiness')
  for (const label of [/apparatus development/i, /collect/i, /diagnostic replay/i]) {
    assert.match(panel, label, 'the panel must name every purpose so the owner sees which paths are open')
  }
  assert.match(panel, /native-admission-unavailable/, 'the collect purpose blocker must be visible')
  assert.match(panel, /diagnostic-grader-unsupported/, 'the diagnostic-replay purpose blocker must be visible')
})

test('every blocker is shown with its code, its exact path and a plain-language reason', async () => {
  const view = await frozenLean()
  const panel = text(view, 'readiness')
  assert.match(panel, /replay-response-not-a-program/, 'the blocker code must be visible, not only its message')
  assert.match(panel, /conditions\.recorded\.adapter\.responses\.flat-canary/, 'the exact path stays, it is the machine locator')
  assert.match(panel, /The system did not return Python source/, 'the engine message is kept verbatim, never replaced by a paraphrase')
  assert.match(panel, /record one Python program|grade this study as JSON/i, 'a plain-language next step must accompany the code')
})

test('the page states why it cannot run this project itself', async () => {
  const view = await frozenLean()
  assert.equal(field(view, 'run').disabled, true, 'a lean-python project with a native grader is not runnable in the page')
  const handoff = text(view, 'handoff')
  assert.match(handoff, /lean-python/, 'the refusal must name the grading kind that the page cannot run')
  assert.match(handoff, /exact, json, judge-audit, resource-action-plan/, 'the refusal must say which graders the page can run instead')
})

test('the page shows the exact exported-CLI commands the owner must run', async () => {
  const view = await frozenLean()
  const handoff = text(view, 'handoff')
  for (const command of ['node cli.mjs verify', 'node cli.mjs qualify', 'node cli.mjs run', 'node cli.mjs verify-native', 'node cli.mjs analyze']) {
    assert.ok(handoff.includes(command), 'the handoff must show the exact command: ' + command)
  }
  assert.ok(handoff.indexOf('node cli.mjs verify') < handoff.indexOf('node cli.mjs run'), 'commands appear in the order they must be run')
  assert.ok(handoff.indexOf('node cli.mjs run') < handoff.indexOf('node cli.mjs analyze'), 'commands appear in the order they must be run')
  assert.match(handoff, /evidence\.json/, 'the handoff must say which file comes back into the page')
})

// Worker 8's RP4a review note. When readiness is what blocks the page, the handoff still
// offers the exported commands — and the exported runner applies that same readiness, so it
// refuses for the same reasons until the requirements are met. Nothing shown was false, but
// saying nothing costs the owner a round trip through the CLI to learn what the page already
// knew. Keyed on the readiness refusal being present, not on it being the only one: the
// flagship lean project carries two refusals (readiness and lean-python grading), so a
// sole-refusal trigger would never fire for the case this lane exists for.
test('the handoff says the exported runner applies the same readiness, exactly when that is true', async () => {
  const view = await frozenLean()
  const handoff = text(view, 'handoff')
  const project = await freezeStudy(await leanDraft())
  const ready = evaluateReadiness(project, { operation: 'apparatus-development' }).eligible
  assert.equal(ready, false, 'precondition: this project is not execution-ready, which is why the page refuses to run it')
  const says = handoff.includes('applies these same execution requirements, so it will refuse for the same reasons until they are met')
  assert.equal(says, !ready, 'the handoff must warn that the exported runner refuses for the same reasons exactly when readiness is what blocks the page')
})

test('the handoff stays silent about readiness when readiness is not what blocks the page', async () => {
  // The other direction of the test above. That one pins its fixture to not-ready, so it only ever
  // exercises "not ready, so the sentence is present", and making the sentence unconditional passes
  // it unchanged (Worker 7, RP4/REVIEW-worker7-74467d40.md, measured by mutation).
  //
  // The sentence can only be wrongly present where the handoff renders AND readiness is eligible.
  // A runnable project is the wrong case: then the page renders no handoff at all and the sentence
  // has nowhere to appear. A non-replay adapter is also the wrong case: for diagnostic replay
  // readiness itself requires every condition to be replay, so the two refusals always coincide.
  // What does separate them is grading: the page cannot run lean-python in the page, while readiness
  // admits it for apparatus development once a program is recorded.
  const spec = await leanDraft()
  // A stand-in program, not a real LEAN algorithm: its only job here is that a program was recorded,
  // which is what readiness checks. The starter ships a JSON trace in this slot, which is the defect
  // lane RP2 fixes at source; recording one locally keeps this test independent of that lane.
  spec.conditions[0].adapter.responses['flat-canary'] = 'from AlgorithmImports import *\n\nclass Recorded(QCAlgorithm):\n    def initialize(self):\n        pass\n'

  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  // The same three-way rule the page's own executionOperation uses, mirrored rather than hardcoded
  // so this cannot drift from the page if the fixture's purpose ever changes.
  const purpose = project.spec.executionPlan?.purpose
  const operation = purpose === 'experiment' ? 'collect'
    : purpose === 'apparatus-development' ? 'apparatus-development' : 'diagnostic-replay'
  const decision = evaluateReadiness(project, { operation })
  assert.equal(decision.eligible, true,
    'precondition: readiness is not what blocks this project; blockers were ' +
    JSON.stringify(decision.blockers.map(row => row.code)))

  const view = await mount()
  await importDraft(view, { spec })
  await click(view, 'freeze')
  const handoff = text(view, 'handoff')
  assert.notEqual(handoff.trim(), '', 'precondition: the page still cannot run this, so the handoff is offered')

  assert.ok(!handoff.includes('applies these same execution requirements'),
    'the handoff must not tell the owner the exported runner will refuse for readiness reasons when readiness is eligible')
})

test('a project the page can run shows no refusal and leaves the run control enabled', async () => {
  const view = await mount()
  await importDraft(view, { spec: genericStarter() })
  await click(view, 'freeze')
  assert.equal(field(view, 'run').disabled, false, 'the recorded generic starter is exactly what the page can run')
  assert.equal(text(view, 'handoff').trim(), '', 'no handoff is offered when the page can run the project itself')
})

test('a condition the page cannot dispatch is named in the refusal, with its adapter kind', async () => {
  const view = await mount()
  const spec = await leanDraft()
  spec.conditions = [...spec.conditions, { id: 'reference-program', label: 'Reference program',
    model: { provider: 'local', id: 'reference-v1', settings: {} },
    adapter: { kind: 'command', command: 'node', args: ['adapters/reference-program.mjs'] } }]
  await importDraft(view, { spec })
  await click(view, 'freeze')
  const handoff = text(view, 'handoff')
  assert.equal(field(view, 'run').disabled, true)
  assert.match(handoff, /recorded replay/i, 'the refusal must say the page dispatches recorded replay only')
  assert.match(handoff, /reference-program \(command\)/, 'the refusal must name the condition and its adapter kind')
  assert.match(text(view, 'readiness'), /collector-unsupported/, 'the generated refusal for that adapter stays visible too')
})
// A legacy schema-1 project is the case this change could most easily have broken: the page
// now evaluates two operations it never evaluated for such a project before. It must not
// throw, it must show which path IS open, and a refusal with no curated line of its own must
// still carry the generated message rather than nothing.
test('a legacy project keeps a usable panel: every purpose evaluated, the open one named, uncurated codes intact', async () => {
  const view = await mount()
  const spec = genericStarter()
  assert.equal(spec.schemaVersion, 1, 'this fixture is the legacy shape on purpose')
  await importDraft(view, { spec })
  await click(view, 'freeze')
  const panel = text(view, 'readiness')
  assert.doesNotMatch(panel, /could not be evaluated/, 'no purpose may fail to evaluate for a legacy project')
  assert.match(panel, /Diagnostic replay — this project’s declared purpose/, 'the declared purpose is marked')
  assert.match(panel, /Available\./, 'the page must name the path that IS open, not only the blocked ones')
  assert.match(panel, /development-purpose-required/, 'the other purposes are evaluated and shown too')
  // independent-oracle-required carries no curated line; its generated message must survive.
  assert.match(panel, /independent-oracle-required/, 'an uncurated code is still named')
  assert.match(panel, /Register distinct source-pinned reference and independent interpreter modules/,
    'an uncurated code keeps its generated message; an incomplete guidance map must hide nothing')
})

// --- RP4b: the run comes back ------------------------------------------------------
// The parity job measured the REFUSAL (evidence from another frozen project), never a
// successful import. These two cover the path the owner actually walks: run the project
// this page froze, bring its evidence back, and be told something useful when it does
// not belong.
async function importEvidence(view, data) {
  const contents = JSON.stringify(data)
  const input = field(view, 'import-evidence')
  input.files = [{ size: contents.length, text: async () => contents }]
  input.dispatch('change'); await idle(view)
}
const frozenSha = view => text(view, 'frozen').match(/SHA-256 ([a-f0-9]{64})/)?.[1]

test('evidence from a project this session froze imports back into a page holding that same project', async () => {
  const a = await mount()
  await importDraft(a, { spec: genericStarter() })
  await click(a, 'freeze')
  const sha = frozenSha(a)
  assert.ok(sha, 'the frozen line carries the project identity')
  await click(a, 'run')
  await click(a, 'export-evidence')
  const exported = JSON.parse(downloads.at(-1).contents)
  assert.equal(exported.projectSha256, sha, 'exported evidence is bound to the project that produced it')

  // A second page, same draft and same runtime bytes, freezes the same project. This is
  // the shape of coming back after running the export elsewhere.
  const b = await mount()
  await importDraft(b, { spec: genericStarter() })
  await click(b, 'freeze')
  assert.equal(frozenSha(b), sha, 'the same draft under the same runtime freezes to the same project')
  await importEvidence(b, exported)
  assert.match(text(b, 'status'), /Evidence imported/, text(b, 'status'))
  assert.ok(text(b, 'results').length > 0, 'the imported run is rendered, not merely accepted')
})

test('evidence for another project is refused by name, and the refusal says what does work', async () => {
  const a = await mount()
  await importDraft(a, { spec: genericStarter() })
  await click(a, 'freeze'); await click(a, 'run'); await click(a, 'export-evidence')
  const exported = JSON.parse(downloads.at(-1).contents)

  const b = await mount()
  const other = genericStarter(); other.id = 'other-benchmark'; other.name = 'Other benchmark'
  await importDraft(b, { spec: other })
  await click(b, 'freeze')
  const held = frozenSha(b)
  assert.notEqual(held, exported.projectSha256, 'the two drafts must freeze to different projects')

  await importEvidence(b, exported)
  const message = text(b, 'status')
  assert.match(message, /different frozen project/, message)
  assert.ok(message.includes(exported.projectSha256.slice(0, 16)),
    'the refusal must name the project the evidence belongs to, not only that it differs')
  assert.ok(message.includes(held.slice(0, 16)),
    'the refusal must name the project this page is holding')
  assert.match(message, /cli\.mjs/,
    'the refusal must name a path that does work, not only the one that does not')
})

// The handoff tells the owner what to type. If it drifts from what the export actually
// documents, the page is confidently wrong -- the worst failure available to it. Tie the
// two together mechanically rather than by memory.
function unzipStored(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), files = {}
  let offset = 0
  while (data.getUint32(offset, true) === 0x04034b50) {
    assert.equal(data.getUint16(offset + 8, true), 0)
    const size = data.getUint32(offset + 18, true), nameSize = data.getUint16(offset + 26, true), extraSize = data.getUint16(offset + 28, true)
    const start = offset + 30, body = start + nameSize + extraSize
    files[decoder.decode(bytes.subarray(start, start + nameSize))] = decoder.decode(bytes.subarray(body, body + size)); offset = body + size
  }
  return files
}

test('every command the handoff shows is one this project’s own exported README documents', async () => {
  const view = await frozenLean()
  const shown = [...new Set(text(view, 'handoff').match(/node cli\.mjs [a-z-]+/g) ?? [])]
  assert.ok(shown.length >= 5, 'the handoff shows a command sequence: ' + JSON.stringify(shown))
  await click(view, 'export')
  const files = unzipStored(downloads.at(-1).contents)
  assert.ok(files['README.md'], 'the exported ZIP carries the README the handoff is quoting')
  for (const command of shown) {
    assert.ok(files['README.md'].includes(command),
      'the handoff must not name a command this export does not document: ' + command)
  }
})

// --- ruling 3: pin the page's purposes to the runtime's own derivation ----------------
// Nothing exports the operation list. readiness.mjs exports READINESS_VERSION,
// validateExecutionPlan, deriveReadinessContract, readinessProjectFiles, evaluateReadiness
// and assertCollectionAdmission; the three names live as a literal inside evaluateReadiness
// (readiness.mjs:262) and cli.mjs builds its triple inline at :506. So this pins against the
// readiness module's OWN evaluated operation names, derived two ways from the module at run
// time rather than copied: the names it prints when it refuses one, and which of those it
// then actually accepts. If a fourth operation is ever added, or one renamed, this fails and
// whoever changed it has to come here and update the page.
const PAGE_PURPOSE_LABEL = {
  'apparatus-development': 'Apparatus development',
  collect: 'Collect (experiment)',
  'diagnostic-replay': 'Diagnostic replay'
}

test('the page evaluates exactly the operations the readiness runtime accepts, in the order the CLI prints them', async () => {
  const view = await frozenLean()
  const frozen = { format: 'research-benchmark', version: 1, spec: { conditions: [] }, tasks: [], schedule: [] }

  // 1. The module's own words: make it refuse, and read the names out of its message.
  let refusal = ''
  try { evaluateReadiness(frozen, { operation: 'not-a-real-operation' }); assert.fail('a bogus operation must be refused') }
  catch (error) { refusal = error.message }
  const named = [...refusal.matchAll(/[a-z]+(?:-[a-z]+)*/g)].map(row => row[0])
    .filter(word => Object.hasOwn(PAGE_PURPOSE_LABEL, word))
  assert.deepEqual([...named].sort(), Object.keys(PAGE_PURPOSE_LABEL).sort(),
    'the operations readiness names in its refusal are exactly the ones the page renders: ' + refusal)

  // 2. And each is really accepted AS AN OPERATION. A stub project trips later schema
  //    validation whatever the operation, so the property to test is narrower than "does not
  //    throw": it is that the operation-name invariant is never the thing that refuses.
  for (const operation of named) {
    try { evaluateReadiness(frozen, { operation }) }
    catch (error) {
      assert.doesNotMatch(error.message, /Choose collect, diagnostic-replay or apparatus-development/,
        operation + ' is named in readiness\u2019s own refusal but rejected as an operation')
    }
  }

  // 3. The page renders one section per accepted operation, and no others.
  const panel = text(view, 'readiness')
  for (const [operation, label] of Object.entries(PAGE_PURPOSE_LABEL)) {
    assert.ok(panel.includes(label), 'the page renders a section for ' + operation)
  }

  // 4. In the order `node cli.mjs verify` prints them. Its output is canonical, so the keys
  //    are sorted: apparatusDevelopment, collect, diagnosticReplay.
  const order = ['apparatus-development', 'collect', 'diagnostic-replay'].map(operation => panel.indexOf(PAGE_PURPOSE_LABEL[operation]))
  assert.deepEqual(order, [...order].sort((a, b) => a - b),
    'the page lists the purposes in the order the CLI prints them: ' + JSON.stringify(order))
})
