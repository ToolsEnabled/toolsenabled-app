import assert from 'node:assert/strict'
import fs from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEV_PROFILE, plainPath, measureFile } from '../lib/adapters/artifact-files.mjs'
import { assertPrivateReadinessPath } from '../release-packager/lib/readiness-handoff.mjs'
import { assertGateWorktreeAvailable } from '../release-packager/lib/gate-quarantine.mjs'
import { normalizeQualificationContext } from '../lib/release-readiness.mjs'
import { fencedPath, unlinkedPath } from '../lib/transport/owned-job.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

test('release file boundaries bind the actual OS account, not a recorded build profile', () => {
  assert.equal(DEV_PROFILE, userInfo().homedir)
})

test('release readers accept real owned files while retaining seal and receipt boundaries', t => {
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'release-owner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'release'))
  const file = path.join(root, 'identity.json')
  fs.writeFileSync(file, '{}\n', { mode: 0o600 })
  assert.equal(plainPath(file, { kind: 'file' }), file)
  assert.equal(unlinkedPath(file), file)
  assert.equal(measureFile(file).bytes, 3)
  assert.equal(assertPrivateReadinessPath(file, { existing: true }), file)
  assert.doesNotThrow(() => assertGateWorktreeAvailable(root))
  fs.mkdirSync(path.join(root, 'release', '.gate-execution-in-flight'))
  assert.throws(() => assertGateWorktreeAvailable(root), /incomplete or unconfirmed/)
  assert.throws(() => assertPrivateReadinessPath(file), /already exists/)
})

test('Windows release boundaries reject another profile before any path inspection', {
  skip: process.platform !== 'win32' && 'Windows only',
}, t => {
  const foreign = path.join(path.dirname(userInfo().homedir), 'Foreign-Qualification-Sentinel', 'input')
  let probes = 0
  t.mock.method(fs, 'lstatSync', () => { probes++; throw new Error('A foreign path must never be inspected') })
  for (const read of [plainPath, fencedPath, unlinkedPath, assertPrivateReadinessPath, assertGateWorktreeAvailable,
    value => normalizeQualificationContext({ sourceRoots: { app: value, engine: value },
      stageRoot: value, harnessRoot: value, evidenceRoot: value }, 'toolsenabled')]) {
    assert.throws(() => read(foreign), /leaves.*(?:profile|root|fence)/)
  }
  assert.equal(probes, 0)
})
