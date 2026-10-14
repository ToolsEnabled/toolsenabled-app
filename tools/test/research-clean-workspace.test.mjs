import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { beforeEach, afterEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { createBenchmarkStore } from '../../src/research-benchmark-store.js'
import { emptyVarianceState, varianceInventory, varianceMark } from '../../src/research-variance.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const A = 'rp-aaaa', B = 'rp-bbbb'
let dom, view, values, downloads, reads, delayedRead
const field = name => view.el.querySelector(`[data-bench-${name}]`)
async function idle() {
  for (let i = 0; i < 100; i++) {
    if (view.el.getAttribute('aria-busy') === 'false') return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('builder did not settle')
}
async function click(name) { assert.equal(field(name).disabled, false, name); field(name).click(); await idle() }
function fill(name, text) { field(name).value = text; field(name).dispatch('input') }
async function exported() { await click('draft-export'); return JSON.parse(downloads.at(-1).contents) }
async function importDraft(spec, editors = {}) {
  const text = JSON.stringify({ spec, editors })
  field('import').files = [{ size: text.length, text: async () => text }]
  field('import').dispatch('change'); await idle()
}
beforeEach(async () => {
  dom = installDomStandIn(globalThis); values = new Map(); downloads = []; reads = []; delayedRead = null
  view = createBenchmarkBuilder({
    account: {
      async getSetting(key) { reads.push(key); if (delayedRead) await delayedRead(key); return { ok: true, value: values.get(key) ?? null } },
      async putSetting(key, value) { values.set(key, value); return { ok: true } },
    },
    loadSources: async () => ({}), download: (name, contents) => downloads.push({ name, contents }),
  })
  document.body.append(view.el)
  await view.setContext(A, 'live')
})
afterEach(() => { view.destroy(); dom.restore() })

test('a new project is empty, can save and restore empty, and examples are an explicit import', async () => {
  const draft = await exported()
  assert.deepEqual(draft.spec.catalog, [])
  assert.deepEqual(draft.spec.tasks, [])
  assert.deepEqual(draft.spec.conditions, [])
  assert.equal(field('routing').value, '')
  assert.match(field('preview-meta').textContent, /No tasks/)
  await click('save')
  await click('load-examples')
  const exampleDraft = await exported()
  assert.equal(exampleDraft.spec.catalog.length, 44)
  assert.deepEqual(exampleDraft.spec.tasks, [])
  await view.setContext(A, 'live', { reload: true })
  assert.deepEqual((await exported()).spec.catalog, [])
})

test('an author can create the first task, delete the last task and snippet, and undo clearing', async () => {
  await click('add-atom')
  fill('bundle-title', 'My instruction'); fill('wording', 'Return hello.')
  await click('apply-bundle'); await click('add-task')
  assert.equal((await exported()).spec.tasks.length, 1)
  await click('delete-snippet')
  assert.match(field('snippet-status').textContent, /used by task-1/)
  await click('delete-task'); await click('delete-snippet')
  let draft = await exported()
  assert.deepEqual(draft.spec.tasks, []); assert.deepEqual(draft.spec.catalog, [])
  await importDraft(genericStarter())
  await click('new-empty')
  assert.deepEqual((await exported()).spec.tasks, [])
  assert.equal(field('undo').hidden, false)
  await click('undo')
  draft = await exported()
  assert.deepEqual(draft.spec.tasks.map(task => task.id), ['addition-a', 'addition-b'])
})

test('project changes isolate tasks, snippets, routing and pending editor text; returning restores only that project', async () => {
  const first = genericStarter(); first.name = 'Project A work'
  await importDraft(first)
  const routing = { version: 1, fields: ['only-a'], compositions: [], decisions: [], rules: [], otherwise: null, rows: [] }
  fill('routing', JSON.stringify(routing))
  fill('wording', 'A unfinished snippet')
  fill('attachment-text', 'A private attachment')
  fill('decisions', 'A unpublished decision')
  await view.setContext(B, 'live')
  let draft = await exported()
  assert.deepEqual(draft.spec.catalog, []); assert.deepEqual(draft.spec.tasks, [])
  for (const name of ['routing', 'wording', 'attachment-text', 'decisions']) assert.equal(field(name).value, '', name)
  assert.deepEqual(draft.pending, [])
  assert.equal(field('undo').hidden, true)
  await importDraft({ ...genericStarter(), name: 'Project B imported work' })
  fill('wording', 'B unfinished snippet')
  await view.setContext(A, 'live')
  assert.equal(field('name').value, 'Project A work')
  assert.equal(field('wording').value, 'A unfinished snippet')
  assert.deepEqual(JSON.parse(field('routing').value), routing)
  assert.equal(field('attachment-text').value, 'A private attachment')
  await view.setContext(B, 'live')
  assert.equal(field('name').value, 'Project B imported work')
  assert.equal(field('wording').value, 'B unfinished snippet')
  assert.equal(JSON.parse(field('routing').value).fields.includes('only-a'), false)
})

test('All projects does not open or write the Unfiled draft', async () => {
  await view.setContext('unfiled', 'live')
  await importDraft({ ...genericStarter(), name: 'Unfiled only' }); await click('save')
  const readCount = reads.length
  await view.setContext('all', 'live')
  assert.equal(reads.length, readCount)
  assert.equal(field('save').disabled, true)
  assert.match(field('scope').textContent, /overview/)
  assert.equal(field('name').value, 'Untitled benchmark')
  await view.setContext(B, 'live')
  assert.deepEqual((await exported()).spec.tasks, [])
  await view.setContext('unfiled', 'live')
  assert.equal(field('name').value, 'Unfiled only')
  await assert.rejects(createBenchmarkStore({}).read('all'), /overview/)
})

test('a late project read cannot populate the next project', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  delayedRead = key => key === 'research_benchmark_rp-cccc' ? blocked : Promise.resolve()
  const earlier = view.setContext('rp-cccc', 'live')
  await view.setContext(B, 'live')
  release(); await earlier
  assert.equal(field('save').disabled, false)
  assert.deepEqual((await exported()).spec.tasks, [])
  await click('save')
  assert.ok(values.has('research_benchmark_' + B))
  assert.equal(values.has('research_benchmark_rp-cccc'), false)
})

test('local draft import and export work in the preview without account writes', async () => {
  await view.setContext('all', 'mock')
  await importDraft(genericStarter())
  assert.equal((await exported()).spec.tasks.length, 2)
  assert.equal(values.size, 0)
})

test('unfinished nesting members and instructions belong only to their project', async () => {
  await importDraft(genericStarter())
  view.el.querySelector('[data-bench-tab="nesting"]').click()
  const nest = name => view.el.querySelector(`[data-nest-${name}]`)
  nest('name').value = 'A unfinished nesting'; nest('name').dispatch('input')
  nest('instructions').value = 'Instructions only for A'; nest('instructions').dispatch('input')
  nest('add-empty').click()
  const retained = JSON.parse((await exported()).editors['data-bench-nesting-draft'])
  assert.equal(retained.form.members.length, 1)
  await view.setContext(B, 'live')
  assert.equal(nest('name').value, '')
  assert.equal(nest('instructions').value, '')
  assert.equal(view.el.querySelectorAll('[data-nest-member]').length, 0)
  await view.setContext(A, 'live')
  assert.equal(nest('name').value, 'A unfinished nesting')
  assert.equal(nest('instructions').value, 'Instructions only for A')
  assert.equal(view.el.querySelectorAll('[data-nest-member]').length, 1)
  await click('new-empty')
  assert.equal(nest('name').value, '')
  await click('undo')
  assert.equal(nest('name').value, 'A unfinished nesting')
})

test('variance selections and study drafts stay in their project and survive Undo', async () => {
  const spec = genericStarter(), state = emptyVarianceState(), study = state.studies[0]
  study.name = 'Only project A'; study.source = { kind: 'task', id: 'addition-a' }
  const inventory = await varianceInventory(spec, null, study.source)
  study.marks = [varianceMark(inventory, 'root/task#1', 0, 6)]
  await importDraft(spec, { 'data-bench-variance-draft': JSON.stringify(state) })
  await view.setContext(B, 'live')
  assert.equal(field('variance-draft').value, '')
  await view.setContext(A, 'live')
  assert.deepEqual(JSON.parse(field('variance-draft').value), state)
  await click('new-empty'); assert.equal(field('variance-draft').value, '')
  await click('undo'); assert.deepEqual(JSON.parse(field('variance-draft').value), state)
  assert.deepEqual(JSON.parse((await exported()).editors['data-bench-variance-draft']), state)
})
test('task-set selection settings stay in their project and survive export and Undo', async () => {
  const state = { source: 'current', studies: [], method: 'weighted', count: '30', seed: '123', dimensions: ['family'], weights: { '["a"]': '2' }, rationale: 'Only project A' }
  await importDraft(genericStarter(), { 'data-bench-prompt-set-draft': JSON.stringify(state) })
  await view.setContext(B, 'live'); assert.equal(field('prompt-set-draft').value, '')
  await view.setContext(A, 'live'); assert.deepEqual(JSON.parse(field('prompt-set-draft').value), state)
  await click('new-empty'); assert.equal(field('prompt-set-draft').value, '')
  await click('undo'); assert.deepEqual(JSON.parse(field('prompt-set-draft').value), state)
  assert.deepEqual(JSON.parse((await exported()).editors['data-bench-prompt-set-draft']), state)
})
