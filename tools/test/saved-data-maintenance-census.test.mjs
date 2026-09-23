import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'
import { inspectSourceSuite, planSourceSuiteJobs } from '../lib/adapters/source-suites.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const required = [
  "tools/test/saved-data-maintenance-audit.test.mjs",
  "tools/test/saved-data-maintenance-composition.test.mjs",
  "tools/test/saved-data-maintenance-controls.test.mjs",
  "tools/test/saved-data-maintenance-engine-contract.test.mjs",
  "tools/test/saved-data-maintenance-ipc.test.mjs",
  "tools/test/saved-data-maintenance-settings.test.mjs",
  "tools/test/saved-data-maintenance.test.mjs",
  "tools/test/saved-node-status-repair.test.mjs",
  "tools/test/saved-tree-maintenance-refresh.test.mjs",
  "tools/test/saved-data-maintenance-census.test.mjs"
]
const selection = inspectSourceSuite('app', { sourceRoots: { app: root } })

for (const file of required) {
  test('maintenance release census requires ' + path.basename(file), () => {
    assert.deepEqual(SOURCE_MANIFESTS.app.inventory.filter(row => row.file === file),
      [{ file, reason: null }], 'executable maintenance suites cannot be omitted or classified as helpers')
    assert.equal(selection.discovered.filter(found => found === file).length, 1)
    assert.equal(selection.files.filter(found => found === file).length, 1)
    assert.equal(selection.exclusions.some(row => row.file === file), false)
    assert.equal(selection.obligations.some(row => row.id === 'unreconciled-tests' && row.files.includes(file)), false)
  })
}

test('the existing test:data invocation discovers every required maintenance suite', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const invocation = scripts['test:data'].split('&&').map(command => command.trim())
    .find(command => command.startsWith('node --test '))
  assert.ok(invocation, 'the default source test runner must remain present')
  assert.ok(invocation.split(/\s+/).includes('tools/test/*.test.mjs'))
  assert.ok(invocation.split(/\s+/).includes('--import=./tools/test/lib/isolate-native-state-root.mjs'))
  const directLeaves = fs.readdirSync(path.join(root, 'tools/test'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => 'tools/test/' + entry.name)
  for (const file of required) assert.ok(directLeaves.includes(file), file)
})

test('maintenance leaf jobs retain strict isolation and the explicitly bound engine', t => {
  // This is actual job planning over a retained synthetic binding, not product
  // maintenance execution or qualification of this checkout's App/Engine pair.
  const fixture = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'maintenance-census-'))
  t.diagnostic('Retained planning fixture: ' + fixture)
  const app = path.join(fixture, 'app'), engine = path.join(fixture, 'engine')
  fs.mkdirSync(path.join(app, 'private'), { recursive: true })
  fs.mkdirSync(path.join(app, 'tools/test'), { recursive: true })
  fs.mkdirSync(engine)
  for (const file of required) fs.writeFileSync(path.join(app, file), '')
  const engineRef = 'b'.repeat(40)
  const record = JSON.stringify({ path: engine, ref: engineRef })
  fs.writeFileSync(path.join(app, 'private/capability-source.owner.json'), record)
  const strictInputs = { root: app, canonicalRoot: engine, appRef: 'a'.repeat(40), engineRef,
    sourceRecord: { bytes: Buffer.byteLength(record), sha256: createHash('sha256').update(record).digest('hex') } }
  const plannedSelection = { id: 'app', root: app, canonicalRoot: engine,
    files: required, crossFiles: [], commands: [] }
  const jobs = planSourceSuiteJobs(plannedSelection, path.join(fixture, 'evidence'), { strictInputs })
  assert.equal(jobs.length, required.length)
  for (const file of required) {
    const matching = jobs.filter(job => job.file === path.join(app, file))
    assert.equal(matching.length, 1, file)
    const job = matching[0]
    assert.deepEqual(job.args, ['--import=./tools/test/lib/isolate-native-state-root.mjs',
      '--test', '--test-reporter=tap', '--test-concurrency=1', path.join(app, file)])
    assert.deepEqual(job.env, { TOOLSENABLED_TEST_STRICT: '1', MC_CANONICAL_ROOT: engine })
    assert.deepEqual(job.sourceBinding, strictInputs)
  }
  assert.throws(() => planSourceSuiteJobs(plannedSelection, fixture), /exact measured app\/engine/)
  assert.throws(() => planSourceSuiteJobs(plannedSelection, fixture,
    { strictInputs: { ...strictInputs, engineRef: 'c'.repeat(40) } }), /source binding/)
})

test('unrelated missing inventory remains an explicit unresolved obligation', () => {
  const inventoried = new Set(SOURCE_MANIFESTS.app.inventory.map(row => row.file))
  const remaining = selection.discovered.filter(file => !inventoried.has(file))
  assert.deepEqual(selection.obligations.filter(row => row.id === 'unreconciled-tests')
    .flatMap(row => row.files), remaining)
  if (remaining.length) assert.equal(selection.complete, false)
})
