// The example snippets are content, not product structure. The test that
// matters is that the product is the same product without them.
//
// There are four categories -- reasons to buy, reasons to sell, how to buy and
// how to sell -- and the software is right; what changes is the data fed into
// it. The library is ONLY those four kinds, one label each. Template nesting and
// compiled depth are product behaviour and are checked where they belong, on
// the product's own bundles, in research-benchmark.test.mjs (`output.depth`)
// and research-benchmark-composition.test.mjs (`rendered.depth`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { catalogMap } from '../../src/benchmark/prompts.mjs'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { importSnippetLibrary, exportSnippetLibrary, filterSnippets, snippetLabels } from '../../src/research-snippets.mjs'
import { EXAMPLE_SNIPPET_IDS, EXAMPLE_SOURCES, exampleSnippetLibrary, isExampleSnippet } from '../../src/research-examples.mjs'

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })

const draft = () => newExperimentDraft(genericStarter(), { initializePopulation: true })
const loaded = () => { const spec = draft(); spec.catalog = importSnippetLibrary(exampleSnippetLibrary(), spec.catalog); return spec }
const examples = () => exampleSnippetLibrary().catalog

// The four kinds, and the one label each kind wears.
const KINDS = {
  reason_to_buy: 'Reason to buy',
  buy_details: 'Buy details',
  reason_to_sell: 'Reason to sell',
  sell_details: 'Sell details',
}

test('the examples arrive through the ordinary import path and are ordinary catalog entries', () => {
  const file = exampleSnippetLibrary()
  assert.equal(file.format, 'benchmark-snippet-library')
  assert.equal(file.version, 1)
  // Exporting them produces the same file, so they carry nothing an exported
  // library could not carry.
  assert.deepEqual(exportSnippetLibrary(file.catalog).catalog, JSON.parse(JSON.stringify(exportSnippetLibrary(file.catalog).catalog)))
  const spec = loaded()
  catalogMap(spec.catalog)
  assert.equal(spec.catalog.length, genericStarter().catalog.length + EXAMPLE_SNIPPET_IDS.length)
  assert.equal(spec.catalog.filter(isExampleSnippet).length, EXAMPLE_SNIPPET_IDS.length)
  for (const bundle of spec.catalog.filter(isExampleSnippet)) {
    // The roles are the example set's own four-part vocabulary, not the
    // product's. What matters is that no code reads them: catalogMap accepts any
    // nonempty string, so a role here is a word in the material and nothing more.
    assert.equal(typeof bundle.role, 'string')
    assert.ok(bundle.role.length > 0)
    assert.deepEqual(bundle.dependencies, undefined, 'and nothing depends on it')
    assert.match(EXAMPLE_SOURCES[bundle.id], /^examples\//, 'every one carries its provenance note')
  }
})

test('no task and no other bundle points at an example, so every one of them can go', () => {
  const spec = loaded()
  const reachable = new Set()
  for (const task of spec.tasks) { const stack = [task.root]; while (stack.length) { const node = stack.pop(); if (node?.use) reachable.add(node.use); stack.push(...Object.values(node?.slots || {})) } }
  for (const id of EXAMPLE_SNIPPET_IDS) assert.equal(reachable.has(id), false, `${id} is not used by any task`)
  for (const bundle of spec.catalog) for (const dependency of bundle.dependencies || []) assert.equal(EXAMPLE_SNIPPET_IDS.includes(dependency), false, `${bundle.id} depends on an example`)
})

test('deleting every example restores the byte-identical frozen project', async () => {
  const before = await freezeStudy(draft())
  const spec = loaded()
  const withExamples = await freezeStudy(spec)
  assert.notEqual(withExamples.sha256, before.sha256, 'while they are present they are part of the project, as any snippet is')
  spec.catalog = spec.catalog.filter(bundle => !EXAMPLE_SNIPPET_IDS.includes(bundle.id))
  const after = await freezeStudy(spec)
  assert.equal(after.sha256, before.sha256, 'and once removed the project is exactly what the starter produces')
})

test('the labels on the examples are what the category strip has to show, and they filter exactly', () => {
  const spec = loaded()
  const labels = [...new Set(spec.catalog.flatMap(snippetLabels))].sort()
  assert.ok(labels.length >= 4, `the strip has real categories to show: ${labels.join(', ')}`)
  for (const label of labels) {
    const matched = filterSnippets(spec.catalog, { label }).map(row => row.bundle.id)
    assert.ok(matched.length > 0)
    for (const id of matched) assert.ok(snippetLabels(spec.catalog.find(b => b.id === id)).includes(label))
  }
  assert.deepEqual(filterSnippets(spec.catalog, { unlabelled: true }).map(row => row.bundle.id), genericStarter().catalog.map(b => b.id),
    'only the starter bundles are uncategorised')
})

/* THE FOUR-KIND RULE, AS A CHECK ON THE DATA. Four kinds, one label each, and
   the strip shows exactly four categories -- not four AMONG others. Counted by
   asking the same function the strip asks (snippetLabels), so this fails the
   way the page would fail. */
test('every example is one of the four kinds and wears exactly one label saying which', () => {
  const library = examples()
  assert.ok(library.length > 0)
  for (const bundle of library) {
    assert.ok(KINDS[bundle.role], `${bundle.id}: role ${bundle.role} is not one of the four kinds`)
    assert.deepEqual(snippetLabels(bundle), [KINDS[bundle.role]], `${bundle.id} carries its one kind label and nothing else`)
    assert.equal(bundle.kind, 'atom', `${bundle.id} is a snippet, not a template`)
    assert.equal(Object.keys(bundle.slots || {}).length, 0, `${bundle.id} holds no slots`)
    assert.equal(bundle.semantics?.kind, 'prompt', `${bundle.id} is prompt wording`)
  }
  const shown = [...new Set(loaded().catalog.flatMap(snippetLabels))].sort()
  assert.deepEqual(shown, Object.values(KINDS).sort(), 'the category strip shows the four kinds and nothing else')
  for (const kind of Object.keys(KINDS))
    assert.ok(library.some(bundle => bundle.role === kind), `${kind} has at least one snippet, so all four categories are real`)
})
