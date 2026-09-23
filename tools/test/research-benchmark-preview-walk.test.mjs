import { useArithmeticExample } from './lib/benchmark-example.mjs'
// What a person meets on the Research page before they have an account.
//
// Every test here was written against a defect found by driving the page in a
// real browser at the shared dev server, and each one fails on the code that
// was there before it:
//
//   1. Freezing sat behind the example-mode guard, so a visitor in the example
//      workspace could build a design and then never reach the readiness
//      report, the frozen inspection, the recorded run or the exported ZIP --
//      refused by a sentence naming save, export, approve and start work, none
//      of which is freezing. Freezing writes nothing and starts nothing; the
//      actions that do are guarded one by one, and this suite holds both halves.
//   2. "Exact apparatus source for review" opened on a File chooser holding no
//      files at all, above a button that reads the file you picked -- from a
//      list you could not reach until you pressed it.
//   3. The builder's numbered steps were numbered in two stylesheets at once,
//      with three steps carrying a different number in each. The page read
//      correctly only because of which file vite happened to load second.
//   4. "Generate tasks from these rules" announced "Every row was routed" for
//      rows that had not composed at all. routedTasks() assembles trees without
//      compiling them, so a row pointing at a bundle whose composition role the
//      place cannot accept was counted and announced as a success while the
//      prompt pane held the compiler's refusal. With the shipped example library
//      that is every one of the 21 T1v0 variants and 25 matching-code bundles at
//      the root address.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36)
const views = []
let installed, fixture, cryptoDescriptor

const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate, what) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause() }
  assert.fail(what || 'the benchmark page did not settle')
}
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const message = view => f(view, 'status').textContent
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
async function click(view, name) {
  assert.equal(f(view, name).disabled, false, `${name} is available`)
  f(view, name).click(); await idle(view)
}
function fill(view, name, value) { const input = f(view, name); assert.equal(input.disabled, false, `${name} is editable`); input.value = value; input.dispatch('input') }
async function choose(view, name, value) { f(view, name).value = value; f(view, name).dispatch('change'); await idle(view) }
async function mount(options = {}) {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources,
    download: (name, contents) => fixture.downloads.push({ name, contents }), ...options })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live')
  await useArithmeticExample(view)
  await until(() => f(view, 'preview-meta').textContent.includes('components'), 'the builder never compiled its starting prompt')
  return view
}

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fixture = { values: new Map(), reads: [], writes: [], downloads: [] }
  fixture.account = {
    async getSetting(key) { fixture.reads.push(key); return { ok: true, value: fixture.values.get(key) ?? null } },
    async putSetting(key, value) { fixture.writes.push({ key, value }); fixture.values.set(key, value); return { ok: true } },
  }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause()
  installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('the example workspace can inspect a frozen design and export its draft while account actions stay unavailable', async () => {
  const view = await mount()
  await view.setContext(A, 'mock')
  await useArithmeticExample(view)
  await until(() => f(view, 'preview-meta').textContent.includes('components'), 'the example workspace never compiled its starting prompt')

  await click(view, 'freeze')
  assert.match(message(view), /^Project frozen\./, 'the example workspace freezes the current design')
  assert.doesNotMatch(f(view, 'frozen').textContent, /Freeze the current specification/,
    'the frozen line stops asking for the freeze that just happened')
  assert.notEqual(f(view, 'readiness').textContent, 'Freeze the applied fields to inspect generated execution requirements.',
    'the readiness surface reports on the frozen project instead of asking to freeze')

  // Nothing about the freeze reached the account, and nothing was written out.
  assert.deepEqual(fixture.writes, [], 'freezing writes nothing to the account')
  assert.deepEqual(fixture.downloads, [], 'freezing writes no file')

  // Each step that would reach an account or start work still refuses by name.
  // A control the frozen project does not offer at all is named rather than
  // quietly counted as refused.
  const refused = [], notOffered = []
  for (const action of ['save', 'export', 'run']) {
    if (f(view, action).disabled) { notOffered.push(action); continue }
    await click(view, action)
    assert.equal(message(view), 'This action requires a connected workspace. You can open, edit and download local draft files in this preview.',
      `${action} still refuses in the example workspace`)
    refused.push(action)
  }
  assert.ok(notOffered.includes('save'), 'account save is disabled in the local preview')
  assert.match(f(view, 'save').title, /Connect your account to save here/)
  assert.ok(refused.includes('export'), 'exporting the runnable project requires a connected workspace')
  assert.deepEqual(fixture.writes, [], 'a refused save writes nothing to the account')
  assert.deepEqual(fixture.downloads, [], 'a refused export writes no file')
  await click(view, 'draft-export')
  assert.equal(JSON.parse(fixture.downloads.at(-1).contents).spec.tasks.length, 2, 'local draft export remains available')
})

test('opening the apparatus source disclosure names every file before anything is pressed, and choosing one shows its exact bytes', async () => {
  const view = await mount()
  const chooser = f(view, 'source-file'), details = f(view, 'source-details')
  const offered = () => [...chooser.querySelectorAll('option')].map(option => option.getAttribute('value'))
  assert.equal(offered().length, 0, 'the chooser starts empty, before the disclosure is opened')

  details.open = true; details.dispatch('toggle')
  await idle(view)
  await until(() => offered().length > 0, 'the chooser was never filled when its disclosure opened')

  assert.deepEqual(new Set(offered()), new Set(Object.keys(sources)),
    'every apparatus file the builder was given is offered by name')

  // A person picks from the list and reads that file; they do not have to press
  // a button to discover what the list contains.
  const wanted = Object.keys(sources).find(name => name !== chooser.value)
  assert.ok(wanted, 'more than one apparatus file is offered')
  await choose(view, 'source-file', wanted)
  assert.equal(f(view, 'source-code').textContent, sources[wanted], 'the chosen file is shown byte for byte')

  // "Read source" still reads the current choice rather than resetting it.
  await click(view, 'load-source')
  assert.equal(chooser.value, wanted, 'reading keeps the file the reviewer chose')
  assert.equal(f(view, 'source-code').textContent, sources[wanted])
})

test('each builder step is numbered once, and the numbers follow the order the steps are rendered in', async () => {
  const view = await mount()
  const order = [...view.el.querySelectorAll('[data-bench-tab]')].map(button => button.getAttribute('data-bench-tab'))
  assert.ok(order.length >= 2, 'the builder renders a step nav')

  // Read every stylesheet beside the page, not a named pair: a number added in a
  // third file is exactly the failure this test exists to catch.
  const dir = new URL('../../src/', import.meta.url)
  const numbered = new Map()
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.css'))) {
    const text = await readFile(new URL(name, dir), 'utf8')
    for (const [, id, shown] of text.matchAll(/\.bench-steps\s+\[data-bench-tab="([^"]+)"\]::before\s*\{[^}]*content:\s*"([^"]*)"/g)) {
      const value = Number(shown.trim().replace(/\.$/, ''))
      assert.ok(Number.isInteger(value) && value > 0, `${name} numbers step ${id} as ${JSON.stringify(shown)}, which is not a step number`)
      numbered.set(id, [...(numbered.get(id) || []), { file: name, value }])
    }
  }

  for (const id of order) {
    const claims = numbered.get(id) || []
    assert.ok(claims.length > 0, `step ${id} is rendered but carries no number`)
    const distinct = [...new Set(claims.map(claim => claim.value))]
    assert.equal(distinct.length, 1,
      `step ${id} is numbered ${distinct.join(' and ')} by ${claims.map(claim => claim.file).join(' and ')}; which one a person sees is decided by stylesheet load order`)
  }

  const shown = order.map(id => numbered.get(id)[0].value)
  assert.deepEqual(shown, order.map((_, index) => index + 1),
    `the steps are rendered in the order ${order.join(', ')} but numbered ${shown.join(', ')}, so a page counts backwards`)
})

test('generating from routing names the rows that did not compose instead of calling every row routed', async () => {
  const view = await mount()

  // A snippet whose composition role the task root cannot accept. This is the
  // ordinary authoring path: name it, write it, give it a role, apply it.
  await click(view, 'add-atom')
  const authored = f(view, 'bundle-id').value
  fill(view, 'bundle-title', 'Walk ablation variant')
  fill(view, 'wording', 'An ablation body that is not a whole task.')
  fill(view, 'bundle-role', 'anchor')
  await click(view, 'apply-bundle')

  await click(view, 'reset-routing')
  const seeded = JSON.parse(f(view, 'routing').value)
  assert.ok(seeded.compositions?.[0]?.node, 'routing seeds a composition from the open task')

  // Half one: a row the compiler cannot compose is reported as such, by row and reason.
  const broken = structuredClone(seeded)
  broken.compositions[0].node = { use: authored }
  fill(view, 'routing', JSON.stringify(broken))
  await click(view, 'apply-routing')

  const refusal = message(view)
  assert.match(refusal, new RegExp(seeded.rows[0].id), 'the refusal names the row that did not compose')
  assert.match(refusal, /anchor/, 'the refusal names the role the bundle carries')
  assert.doesNotMatch(refusal, /task generated from your routing/,
    'a row that did not compose is not announced as a generated task')
  assert.doesNotMatch(f(view, 'routing-status').textContent, /Every row was routed/,
    'the routing line does not claim every row was routed when one was not')

  // Half two: the routing the page seeds for itself still composes, and still
  // reports a plain success. The gate must not simply refuse everything.
  fill(view, 'routing', JSON.stringify(seeded))
  await click(view, 'apply-routing')
  assert.match(message(view), /task generated from your routing/, 'a clean generation still reports success')
  assert.match(f(view, 'routing-status').textContent, /Every row was routed/)
  assert.doesNotMatch(f(view, 'prompt').textContent, /accepts node/,
    'the clean generation compiles to a prompt, not to the compiler refusal')
})
