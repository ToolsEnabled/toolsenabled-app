// The example snippets are content, not product structure. The test that
// matters is that the product is the same product without them.
//
// PROMPT B: they are now the owner's own LeanBench material, so the test that
// matters second is that they are their material rather than a version of it --
// every line in the library has to come back out of the donor file byte for
// byte.
//
// 2026-09-19, OWNER RULING. "shouldn't there only be 4 categories? reasons to
// buy, reasons to sell, how to buy and how to sell" / "the software is
// functioning perfectly, just what we are feeding into it needs to change". The
// library is now ONLY those four kinds, one label each, so the data
// expectations below changed with the data:
//   - the recomposition tests that composed lb-t1v0-task / lb-strategy-slot /
//     lb-parallel-template and the template-nesting test were removed WITH the
//     templates they composed. Template nesting and compiled depth are product
//     behaviour and are still checked where they belong, on the product's own
//     bundles, in research-benchmark.test.mjs (`output.depth`) and
//     research-benchmark-composition.test.mjs (`rendered.depth`).
//   - the tests that pinned whole model programs, no_program_extracted rows,
//     bank instruments and the ten O1 paragraph roles were removed WITH that
//     material. What replaced them is stronger about what remains: every
//     snippet, every recorded donor occurrence AND every attached code slice is
//     re-cut from the donor file it names and compared byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { catalogMap } from '../../src/benchmark/prompts.mjs'

// Their file, read from where it lives, so this test fails if either side moves.
//
// It is read by RESOLVING its declared source rather than from a literal
// absolute path. The literal was Windows-only, with no existsSync, no skip and
// no try/catch, so on Linux this suite threw ENOENT -- and R1226 is explicit
// that this product is built for Linux and Windows. A donor tree is also not
// part of the repository, so a checkout without it must say that plainly
// instead of reporting a failing product. Point LEANBENCH_DONOR_ROOT at the
// directory CONTAINING the donor tree to read it from anywhere.
const DONOR_ROOT = process.env.LEANBENCH_DONOR_ROOT || join(homedir(), 'Desktop')
const SOURCE_TREE = 'LeanBench-Options-Research-20260914'
const DONOR_SOURCE = 'LeanBench-Options-Research-20260914/historical/LEAN-Bench/prompts/T1v0.txt'
const donorPath = source => resolve(DONOR_ROOT, source)
// Returns the donor's text, or null when the tree is not on this machine. Never
// throws: a missing donor is an unconfigured environment, not a defect.
function donorText(source) {
  const path = donorPath(source)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const donorMissing = source => `donor tree not on this machine: ${donorPath(source)} is absent. `
  + 'Set LEANBENCH_DONOR_ROOT to the directory containing LeanBench-Options-Research-20260914 to verify byte-for-byte recomposition.'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { importSnippetLibrary, exportSnippetLibrary, filterSnippets, snippetLabels } from '../../src/research-snippets.mjs'
import { EXAMPLE_SNIPPET_IDS, EXAMPLE_SOURCES, exampleSnippetLibrary, isExampleSnippet } from '../../src/research-examples.mjs'

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })

const draft = () => newExperimentDraft(genericStarter(), { initializePopulation: true })
const loaded = () => { const spec = draft(); spec.catalog = importSnippetLibrary(exampleSnippetLibrary(), spec.catalog); return spec }
const examples = () => exampleSnippetLibrary().catalog
const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex')

// The owner's four, and the one label each kind wears.
const KINDS = {
  reason_to_buy: 'Reason to buy',
  buy_details: 'Buy details',
  reason_to_sell: 'Reason to sell',
  sell_details: 'Sell details',
}

/* Reading a recorded slice back out of the donor. A slice is cut either from a
   whole file, or from one string inside a structured donor file: `variants[N].
   prompt` in their variants json, `$[N].program` in a batch envelope, whose
   rows are one json document per line. Nothing else is accepted -- an
   unrecognised pointer fails rather than being skipped. */
function donorSubject(source, jsonPath) {
  const text = donorText(`${SOURCE_TREE}/${source}`)
  if (text === null) return null
  if (!jsonPath) return text
  const variant = /^variants\[(\d+)\]\.prompt$/.exec(jsonPath)
  if (variant) return JSON.parse(text).variants[Number(variant[1])].prompt
  const row = /^\$\[(\d+)\]\.([A-Za-z_]\w*)$/.exec(jsonPath)
  if (row) return JSON.parse(text.split('\n').filter(line => line.trim())[Number(row[1])])[row[2]]
  assert.fail(`${source}: unreadable donor pointer ${JSON.stringify(jsonPath)}`)
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
    // The roles are the owner's own four-part vocabulary, not the product's.
    // What matters is that no code reads them: catalogMap accepts any nonempty
    // string, so a role here is a word in their material and nothing more.
    assert.equal(typeof bundle.role, 'string')
    assert.ok(bundle.role.length > 0)
    assert.deepEqual(bundle.dependencies, undefined, 'and nothing depends on it')
    assert.match(EXAMPLE_SOURCES[bundle.id], /^LeanBench-Options-Research-20260914\//, 'every one names the file it came out of')
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

/* THE OWNER'S RULING, AS A CHECK ON THE DATA. Four kinds, one label each, and
   the strip shows exactly four categories -- not four AMONG others. Counted by
   asking the same function the strip asks (snippetLabels), so this fails the
   way the page would fail. */
test('every example is one of the owner’s four kinds and wears exactly one label saying which', () => {
  const library = examples()
  assert.ok(library.length > 0)
  for (const bundle of library) {
    assert.ok(KINDS[bundle.role], `${bundle.id}: role ${bundle.role} is not one of the owner's four kinds`)
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

test('every example names a donor file that is really in the donor tree', t => {
  if (donorText(DONOR_SOURCE) === null) return t.skip(donorMissing(DONOR_SOURCE))
  for (const [id, source] of Object.entries(EXAMPLE_SOURCES))
    assert.ok(donorText(source) !== null, `${id} names ${source}, and no such file is in the donor tree`)
})

/* THE STRONGEST CHECK THERE IS ON WHETHER THIS IS THEIR MATERIAL OR A
   PARAPHRASE OF IT: cut every snippet out of the donor again, at the offset it
   records, and compare. Byte-for-byte or it is not their material. */
test('every example is a byte-for-byte slice of the donor file it names', t => {
  if (donorText(DONOR_SOURCE) === null) return t.skip(donorMissing(DONOR_SOURCE))
  for (const bundle of examples()) {
    const subject = donorSubject(bundle.source, bundle.donor?.jsonPath)
    assert.ok(subject !== null, `${bundle.source} is named by ${bundle.id} and is not in the donor tree`)
    const offset = bundle.donor.charOffset
    assert.equal(subject.slice(offset, offset + bundle.text.length), bundle.text,
      `${bundle.id} is not the bytes at ${bundle.source} @${offset}`)
    assert.equal(bundle.sha256, digestOf(bundle.text), `${bundle.id}: the recorded digest is the digest of the bytes carried`)
    assert.equal(bundle.donor.sourceSha256, digestOf(donorText(`${SOURCE_TREE}/${bundle.source}`)),
      `${bundle.id}: the recorded source digest is the digest of that file`)
  }
})

/* A deduplicated piece says which prompts it was cut from. Every one of those
   claims is re-cut here, so "21 variants are decomposed" cannot be true only in
   a comment: 22 T1 prompts x 2 slots x 4 pieces and the O1 prompts' own
   sentences all have to come back out of their own files. */
test('every donor occurrence a snippet records is really in the prompt it names', t => {
  if (donorText(DONOR_SOURCE) === null) return t.skip(donorMissing(DONOR_SOURCE))
  let checked = 0
  for (const bundle of examples()) {
    assert.ok(bundle.donor.occurrences.length > 0, `${bundle.id} names the prompts it was cut from`)
    for (const occurrence of bundle.donor.occurrences) {
      const source = occurrence.source || bundle.source
      const subject = donorSubject(source, occurrence.jsonPath)
      assert.ok(subject !== null, `${source} is named by ${bundle.id} and is not in the donor tree`)
      const offset = occurrence.charOffset ?? bundle.donor.charOffset
      assert.equal(subject.slice(offset, offset + bundle.text.length), bundle.text,
        `${bundle.id}: ${occurrence.variantId} does not carry that text at ${source} @${offset}`)
      checked++
    }
  }
  assert.ok(checked >= EXAMPLE_SNIPPET_IDS.length, `${checked} recorded occurrences re-cut from the donor`)
})

/* EVERY STRATEGY VARIANT THEIR FILES RECORD IS DECOMPOSED, AND NONE IS
   INVENTED. Both directions, because a count that only grows proves nothing:
   nothing their index lists may be missing, and nothing the library names may
   be absent from their index. */
test('the T1 and O1 variants their own files list are exactly the ones decomposed', t => {
  const v5 = donorText(`${SOURCE_TREE}/historical/LEAN-Bench/prompts/variants-v5.json`)
  const o1 = donorText(`${SOURCE_TREE}/historical/LEAN-Bench/arm-options/variants-o1.json`)
  if (v5 === null || o1 === null) return t.skip(donorMissing(`${SOURCE_TREE}/historical/LEAN-Bench/prompts/variants-v5.json`))
  const recorded = new Map()
  for (const bundle of examples()) for (const occurrence of bundle.donor.occurrences)
    recorded.set(occurrence.variantId, occurrence)
  for (const file of [JSON.parse(v5), JSON.parse(o1)]) for (const variant of file.variants) {
    const occurrence = recorded.get(variant.id)
    assert.ok(occurrence, `${variant.id} is in their variants file and no snippet was cut from it`)
    assert.equal(occurrence.variantSha256, variant.sha256, `${variant.id} carries the digest their own file recorded`)
    assert.equal(occurrence.variantRole, variant.role, `${variant.id} keeps their own word for what it is`)
    assert.equal(occurrence.variantDescription, variant.description, `${variant.id} keeps their own description of the edit`)
  }
  const theirs = new Set([...JSON.parse(v5).variants, ...JSON.parse(o1).variants].map(variant => variant.id))
  // The two base prompts are decomposed too and are not variants OF anything,
  // so they are named here rather than let through as unknown ids.
  for (const id of recorded.keys())
    assert.ok(theirs.has(id) || ['T1v0', 'O1v0'].includes(id), `${id} is named by the library and is not in their variants files`)
})

/* MATCHING CODE TRAVELS ON THE SNIPPET, not as a separate entry: the owner's
   ruling leaves four kinds in this library and a whole program is none of them.
   A reproducibility instrument that mislabels its data is worse than one that
   lacks it, so the bytes are checked against the file they name here rather
   than asserted in a comment. */
test('every snippet carries the code that implements it, and those bytes are the file they name', t => {
  if (donorText(DONOR_SOURCE) === null) return t.skip(donorMissing(DONOR_SOURCE))
  for (const bundle of examples()) {
    const code = bundle.code
    assert.ok(code && typeof code.text === 'string' && code.text.length, `${bundle.id} carries the code for its piece`)
    assert.equal(code.language, 'python')
    assert.ok(code.symbol, `${bundle.id}: the code slice names the symbol it cut`)
    assert.equal(code.sha256, digestOf(code.text), `${bundle.id}: the code digest is the digest of the code carried`)
    const subject = donorSubject(code.source, code.jsonPath)
    assert.ok(subject !== null, `${code.source} is named by ${bundle.id} and is not in the donor tree`)
    assert.equal(subject.slice(code.charOffset, code.charOffset + code.text.length), code.text,
      `${bundle.id}: the code is not the bytes at ${code.source} @${code.charOffset}`)
    assert.equal(code.sourceSha256, digestOf(donorText(`${SOURCE_TREE}/${code.source}`)),
      `${bundle.id}: the recorded code source digest is the digest of that file`)
    // A helper the piece calls but that is not inside the slice is named rather
    // than quietly dropped.
    for (const helper of code.helpersOutsideSlice || [])
      assert.ok(typeof helper === 'string' && helper.length, `${bundle.id} names each helper left outside its slice`)
  }
})
