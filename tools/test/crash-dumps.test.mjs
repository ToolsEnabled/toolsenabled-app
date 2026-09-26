import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  CRASH_DUMP_DIR_NAME,
  MAX_CRASH_DUMPS,
  SECRETS_BEARING,
  crashReporterOptions,
  isExcludedFromCollection,
  crashDumpFilesToDelete,
} = require('../../shell/crash-dumps.cjs')

function valuesDeep(value) {
  if (value === null || typeof value !== 'object') return [value]
  return Object.values(value).flatMap(valuesDeep)
}

test('crash reporter is explicitly local-only', () => {
  const options = crashReporterOptions()

  assert.equal(options.uploadToServer, false)
})

test('crash reporter has no upload endpoint under any key', () => {
  const options = crashReporterOptions()

  assert.equal(Object.hasOwn(options, 'submitURL'), false)
  assert.equal(
    valuesDeep(options).some((value) => (
      typeof value === 'string' && /^https?:\/\//i.test(value)
    )),
    false,
  )
})

test('crash dumps are declared secrets-bearing and excluded from collectors', () => {
  assert.equal(SECRETS_BEARING.uploadPermitted, false)
  assert.deepEqual(
    [...SECRETS_BEARING.neverInclude].sort(),
    [
      'support-bundle',
      'log-export',
      'diagnostic-archive',
      'clean-room-export',
      'telemetry',
    ].sort(),
  )
  assert.equal(isExcludedFromCollection(`${CRASH_DUMP_DIR_NAME}/pending/example.dmp`), true)
  assert.equal(isExcludedFromCollection('shell-state.json'), false)
})

test('retention deletes oldest dumps first and keeps no more than the cap', () => {
  const dumps = Array.from({ length: MAX_CRASH_DUMPS + 2 }, (_, index) => ({
    name: `dump-${index}.dmp`,
    mtimeMs: index + 1,
  }))

  assert.deepEqual(crashDumpFilesToDelete(dumps), ['dump-0.dmp', 'dump-1.dmp'])
  assert.equal(dumps.length - crashDumpFilesToDelete(dumps).length, MAX_CRASH_DUMPS)
  assert.deepEqual(crashDumpFilesToDelete(dumps.slice(0, MAX_CRASH_DUMPS - 1)), [])
})

test('retention breaks equal-time ties independently of the host locale', () => {
  const sameTime = [
    { name: 'a.dmp', mtimeMs: 1 },
    { name: 'Z.dmp', mtimeMs: 1 },
  ]

  assert.deepEqual(crashDumpFilesToDelete(sameTime, 1), ['Z.dmp'])
})

test('retention fails closed for malformed input', () => {
  const valid = [
    { name: 'newer.dmp', mtimeMs: 2 },
    { name: 'older.dmp', mtimeMs: 1 },
  ]

  assert.doesNotThrow(() => crashDumpFilesToDelete([{ name: 'unknown-age.dmp' }], 0))
  assert.deepEqual(crashDumpFilesToDelete([{ name: 'unknown-age.dmp' }], 0), [])
  assert.deepEqual(crashDumpFilesToDelete([null, ...valid], 0), [])
  assert.deepEqual(crashDumpFilesToDelete([], 0), [])
  assert.deepEqual(crashDumpFilesToDelete(null, 0), [])
  assert.deepEqual(crashDumpFilesToDelete(valid, -1), [])
})
