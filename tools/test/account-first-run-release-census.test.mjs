import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'
import { inspectSourceSuite } from '../lib/adapters/source-suites.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const suites = [
  'tools/test/account-first-run-guidance.test.mjs',
  'tools/test/account-first-run-release-census.test.mjs',
  'tools/test/account-form-refusal-retention.test.mjs',
  'tools/test/account-reset-platform-guidance.test.mjs',
  'tools/test/setup-account-field-visibility.test.mjs',
]
const helpers = [
  'tools/test/helpers/setup-account-fields-electron.cjs',
  'tools/test/helpers/setup-account-fields-renderer.mjs',
]
const selection = inspectSourceSuite('app', { sourceRoots: { app: root } })

test('release census requires every account first-run regression as an executable suite', () => {
  for (const file of suites) {
    assert.deepEqual(SOURCE_MANIFESTS.app.inventory.filter(row => row.file === file),
      [{ file, reason: null }], file + ' must be a required executable')
    assert.equal(selection.discovered.filter(found => found === file).length, 1, file + ' must exist')
    assert.equal(selection.files.filter(found => found === file).length, 1, file + ' must be selected')
    assert.equal(selection.exclusions.some(row => row.file === file), false)
    assert.equal(selection.obligations.some(row => row.id === 'unreconciled-tests' && row.files.includes(file)), false)
  }
})

test('release census distinguishes the two setup layout helpers from their executable owner', () => {
  for (const file of helpers) {
    assert.deepEqual(SOURCE_MANIFESTS.app.inventory.filter(row => row.file === file),
      [{ file, reason: 'imported-fixture-helper' }])
    assert.equal(selection.discovered.filter(found => found === file).length, 1, file + ' must exist')
    assert.equal(selection.files.includes(file), false, 'a child fixture is not an independent suite')
    assert.equal(selection.exclusions.filter(row => row.file === file).length, 1)
  }
  assert.equal(selection.files.filter(file => file === 'tools/test/setup-account-field-visibility.test.mjs').length, 1,
    'excluding helper modules must not exclude the suite that executes them')
})
