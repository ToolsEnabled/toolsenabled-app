import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { packageLockParityProblems } from '../release-packager/lib/package-lock-parity.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function satisfiesCaretThree(version, range) {
  const match = /^\^(3\.\d+\.\d+)$/.exec(String(range))
  return Boolean(match) && version.startsWith('3.') && compareVersions(version, match[1]) >= 0
}

test('package-lock root version and dependency declarations exactly match package.json', () => {
  assert.deepEqual(packageLockParityProblems(pkg, lock), [])
})

test('nanoid is a compatible lock-only transitive at 3.3.18 or newer', () => {
  assert.equal(pkg.dependencies?.nanoid, undefined, 'nanoid must not become a direct runtime dependency')
  assert.equal(pkg.devDependencies?.nanoid, undefined, 'nanoid must not become a direct devDependency')
  assert.equal(lock.packages['']?.dependencies?.nanoid, undefined, 'the lock root must not declare nanoid directly')
  assert.equal(lock.packages['']?.devDependencies?.nanoid, undefined, 'the lock root must not declare nanoid directly')

  const resolved = lock.packages['node_modules/nanoid']?.version
  assert.ok(resolved, 'package-lock has no resolved nanoid package')
  assert.ok(compareVersions(resolved, '3.3.18') >= 0, `nanoid ${resolved} is below the 3.3.18 floor`)

  const dependentRanges = Object.entries(lock.packages)
    .flatMap(([name, entry]) => entry?.dependencies?.nanoid ? [{ name, range: entry.dependencies.nanoid }] : [])
  assert.ok(dependentRanges.length > 0, 'no transitive package declares nanoid; a lock-only pin would be orphaned')
  for (const dependent of dependentRanges) {
    assert.ok(
      satisfiesCaretThree(resolved, dependent.range),
      `${dependent.name} declares nanoid ${dependent.range}, which does not accept locked ${resolved}`,
    )
  }
})
