import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt, createReviewRecord, reviewStatus } from '../../src/benchmark/prompts.mjs'
import { parseSnippetLabels, snippetMetadata, filterSnippets, exportSnippetLibrary, importSnippetLibrary } from '../../src/research-snippets.mjs'

const atom = (id, extra = {}) => ({ id, version: '1', kind: 'atom', role: 'node', text: 'Return the requested value.', parameters: {}, semantics: { kind: 'prompt' }, ...extra })

test('user-defined labels retain their spelling and normalize whitespace and duplicates', () => {
  assert.deepEqual(parseSnippetLabels(' Reason to buy, How to buy, reason to BUY\n測定 '), ['Reason to buy', 'How to buy', '測定'])
  assert.throws(() => parseSnippetLabels(['invalid,label']), /commas/)
  assert.throws(() => parseSnippetLabels([42]), /text/)
  assert.throws(() => snippetMetadata(' ', []), /name/)
})

test('labels organize any domain independently of the composition role', () => {
  const catalog = [atom('a', { title: 'Initial observation', labels: ['Measurements', '__unlabelled__'] }), atom('b', { title: 'Execute purchase', labels: ['How to buy', 'Actions'] }), atom('c')]
  assert.deepEqual(filterSnippets(catalog, { label: 'how TO buy' }).map(row => row.bundle.id), ['b'])
  assert.deepEqual(filterSnippets(catalog, { label: '__unlabelled__' }).map(row => row.bundle.id), ['a'])
  assert.deepEqual(filterSnippets(catalog, { unlabelled: true }).map(row => row.bundle.id), ['c'])
  assert.deepEqual(filterSnippets(catalog, { label: 'Measurements', search: 'initial' }).map(row => row.bundle.id), ['a'])
  assert.equal(filterSnippets(catalog, { search: 'Return the requested' }).length, 3)
})

test('portable snippet libraries preserve labels, templates, code and dependency definitions', () => {
  const catalog = [atom('a', { title: 'Read a sensor', labels: ['Observation'], code: { language: 'text', contents: 'preserved' }, review: { reviewer: 'old record' } }), { ...atom('wrap'), kind: 'template', text: 'Check {{slot:item}}', slots: { item: 'node' }, dependencies: ['a'] }]
  const file = JSON.parse(JSON.stringify(exportSnippetLibrary(catalog)))
  const restored = importSnippetLibrary(file, [atom('existing')])
  assert.equal(restored.length, 3)
  assert.deepEqual(restored[1].labels, ['Observation'])
  assert.deepEqual(restored[1].code, catalog[0].code)
  assert.equal(restored[1].review, undefined)
  assert.deepEqual(restored[2].slots, { item: 'node' })
  assert.equal(importSnippetLibrary(file, restored).length, 3)
  assert.equal(catalog[0].review.reviewer, 'old record', 'export does not mutate the source')
})

test('a conflicting import or missing dependency refuses the whole merge and preserves current snippets', () => {
  const catalog = [atom('a')], prior = structuredClone(catalog)
  const conflict = exportSnippetLibrary([atom('new'), atom('a', { text: 'Different wording.' })])
  assert.throws(() => importSnippetLibrary(conflict, catalog), /different snippet/)
  assert.deepEqual(catalog, prior)
  assert.throws(() => importSnippetLibrary(exportSnippetLibrary([atom('dependent', { dependencies: ['absent'] })]), catalog), /missing dependency/)
})

test('changing labels preserves prompt meaning but requires a review of the new exact version', async () => {
  const original = atom('a'), review = await createReviewRecord([original], 'a', 'Synthetic test reviewer')
  const renamed = { ...original, ...snippetMetadata('Reason to buy', ['Conditions', 'Entry']) }
  const before = await compilePrompt([original], { use: 'a' })
  const after = await compilePrompt([renamed], { use: 'a' })
  assert.equal(after.text, before.text)
  assert.deepEqual(after.semantic, before.semantic)
  assert.equal((await reviewStatus(renamed, { catalog: [renamed], reviews: [review] })).approved, false)
})

// owner organises a library, so both are asserted here by value.
test('a category filter selects that category exactly, never a merely similar one', () => {
  const catalog = [atom('a', { title: 'Enter', labels: ['Entry'] }), atom('b', { title: 'Leave', labels: ['Exit'] }), atom('c', { title: 'Both', labels: ['Entry point', 'Exit'] })]
  assert.deepEqual(filterSnippets(catalog, { label: 'Entry' }).map(row => row.bundle.id), ['a'], 'Entry does not pull in Entry point or Exit')
  assert.deepEqual(filterSnippets(catalog, { label: 'Entry point' }).map(row => row.bundle.id), ['c'])
  assert.deepEqual(filterSnippets(catalog, { label: 'Exit' }).map(row => row.bundle.id), ['b', 'c'])
  assert.deepEqual(filterSnippets(catalog, { label: 'Ent' }).map(row => row.bundle.id), [], 'a prefix of a category is not that category')
  assert.deepEqual(filterSnippets(catalog, { label: 'ENTRY' }).map(row => row.bundle.id), ['a'], 'matching ignores case only')
})

test('searching finds a snippet by its category, as the search box offers', () => {
  const catalog = [atom('a', { title: 'Enter', labels: ['Reason to buy'] }), atom('b', { title: 'Leave', labels: ['Reason to sell'] })]
  assert.deepEqual(filterSnippets(catalog, { search: 'reason to buy' }).map(row => row.bundle.id), ['a'], 'a category name typed into search finds its snippet')
  assert.deepEqual(filterSnippets(catalog, { search: 'Reason to' }).map(row => row.bundle.id), ['a', 'b'])
  assert.deepEqual(filterSnippets(catalog, { search: 'Enter' }).map(row => row.bundle.id), ['a'], 'searching by name still works')
  assert.deepEqual(filterSnippets(catalog, { search: 'requested value' }).map(row => row.bundle.id), ['a', 'b'], 'searching by text still works')
})
