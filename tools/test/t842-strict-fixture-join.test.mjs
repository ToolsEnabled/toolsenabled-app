// UNRUN source-only T1235 regression. No generic allocator or smoke execution.
// All created directories and synthetic evidence are retained.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createT842RetainedFixtureRoot } from './lib/t842-retained-fixture-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const fixture = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 't842-strict-join-check-'))
function setup(label) {
  const root = path.join(fixture, label)
  const source = path.join(root, 'source')
  const parent = path.join(root, 'retained-parent')
  const leaf = path.join(parent, 'current-child')
  const other = path.join(parent, 'previous-child')
  const imageTemp = path.join(leaf, 'image-test-temp')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(imageTemp, { recursive: true })
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'preserved.txt'), 'previous retained evidence', { flag: 'wx' })
  const environment = {
    TOOLSENABLED_TEST_STRICT: '1',
    TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1',
    TOOLSENABLED_TEST_RETAIN_FIXTURES: '1',
    TOOLSENABLED_TEST_FIXTURE_PARENT: parent,
    TMPDIR: leaf, TEMP: leaf, TMP: leaf, IMAGE_TEST_TEMP: imageTemp,
  }
  return { root, source, parent, leaf, other, imageTemp, environment }
}
function contents(root) { return fs.readdirSync(root).sort() }

test('strict native image scratch stays in the current child without parent siblings', () => {
  const input = setup('strict-child')
  const parentBefore = contents(input.parent)
  const childBefore = contents(input.leaf)
  const first = createT842RetainedFixtureRoot({
    sourceRoots: [input.source], strictEnvironment: input.environment,
  })
  const second = createT842RetainedFixtureRoot({
    sourceRoots: [input.source], strictEnvironment: input.environment,
  })
  assert.equal(path.dirname(first), input.imageTemp)
  assert.equal(path.dirname(second), input.imageTemp)
  assert.notEqual(first, second)
  assert.deepEqual(contents(input.parent), parentBefore)
  assert.deepEqual(contents(input.leaf), childBefore)
  assert.deepEqual(contents(input.source), [])
  assert.equal(fs.readFileSync(path.join(input.other, 'preserved.txt'), 'utf8'), 'previous retained evidence')
})

test('strict explicit parent override refuses without allocating a sibling', () => {
  const input = setup('strict-override')
  const before = contents(input.parent)
  assert.throws(() => createT842RetainedFixtureRoot({
    baseRoot: input.parent, sourceRoots: [input.source], strictEnvironment: input.environment,
  }), { code: 'T842_FIXTURE_OUTSIDE_STRICT_CHILD' })
  assert.deepEqual(contents(input.parent), before)
  assert.deepEqual(contents(input.imageTemp), [])
  const nested = path.join(input.imageTemp, 'explicit-nested')
  fs.mkdirSync(nested)
  const result = createT842RetainedFixtureRoot({
    baseRoot: nested, sourceRoots: [input.source], strictEnvironment: input.environment,
  })
  assert.equal(path.dirname(result), nested)
  assert.deepEqual(contents(input.parent), before)
})

test('strict image scratch rejects incomplete or mismatched preload bindings before writing', () => {
  const input = setup('strict-mismatch')
  const parentBefore = contents(input.parent)
  const foreignScratch = path.join(input.other, 'image-test-temp')
  fs.mkdirSync(foreignScratch)
  for (const changed of [
    { IMAGE_TEST_TEMP: foreignScratch },
    { TEMP: input.parent },
    { TOOLSENABLED_TEST_FIXTURE_PARENT: input.root },
  ]) {
    assert.throws(() => createT842RetainedFixtureRoot({
      sourceRoots: [input.source], strictEnvironment: { ...input.environment, ...changed },
    }), { code: 'T842_STRICT_FIXTURE_MISMATCH' })
  }
  assert.throws(() => createT842RetainedFixtureRoot({
    sourceRoots: [input.source],
    strictEnvironment: { ...input.environment, TOOLSENABLED_TEST_RETAIN_FIXTURES: undefined },
  }), { code: 'T842_STRICT_FIXTURE_REQUIRED' })
  assert.deepEqual(contents(input.imageTemp), [])
  assert.deepEqual(contents(foreignScratch), [])
  assert.deepEqual(contents(input.parent), parentBefore)
})

test('ordinary mode preserves owned default and explicit roots while ignoring ambient image selectors', () => {
  const input = setup('ordinary')
  const environment = { IMAGE_TEST_TEMP: 'untrusted-relative-selector', TOOLSENABLED_TEST_STRICT: '0' }
  const parentBefore = contents(input.parent)
  const ordinary = path.join(input.root, 'ordinary-retained')
  fs.mkdirSync(ordinary)
  const explicit = createT842RetainedFixtureRoot({
    baseRoot: ordinary, sourceRoots: [input.source], strictEnvironment: environment,
  })
  assert.equal(path.dirname(explicit), ordinary)
  const defaultRoot = createT842RetainedFixtureRoot({
    sourceRoots: [input.source], strictEnvironment: environment,
  })
  assert.equal(path.dirname(defaultRoot), ownedFixtureTempRoot())
  assert.notEqual(defaultRoot, explicit)
  assert.deepEqual(contents(input.parent), parentBefore)
  assert.deepEqual(contents(input.source), [])
})

test('the t842 fixture suites and their helper have explicit census ownership', async () => {
  const { SOURCE_MANIFESTS } = await import('../lib/adapters/source-suite-manifests.mjs')
  const source = await import('../lib/adapters/source-suites.mjs')
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const selection = source.inspectSourceSuite('app', { sourceRoots: { app: appRoot } })
  const leaves = ['tools/test/t842-retained-fixture-root.test.mjs', 'tools/test/t842-strict-fixture-join.test.mjs']
  const helper = 'tools/test/lib/t842-retained-fixture-root.mjs'
  const inventory = SOURCE_MANIFESTS.app.inventory
  for (const leaf of leaves) {
    assert.deepEqual(inventory.filter(row => row.file === leaf), [{ file: leaf, reason: null }])
    assert.ok(selection.files.includes(leaf), leaf + ' is a required test execution')
  }
  assert.deepEqual(inventory.filter(row => row.file === helper), [{ file: helper, reason: 'imported-fixture-helper' }])
  assert.equal(selection.files.includes(helper), false, 'an imported helper is measured without a standalone execution')
  assert.deepEqual(selection.obligations.filter(row => ['missing-tests', 'unreconciled-tests'].includes(row.id)
    && row.files.some(file => leaves.includes(file) || file === helper)), [])
})
