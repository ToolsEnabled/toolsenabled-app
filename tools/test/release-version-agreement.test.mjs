/* The version fields of one release must agree, and must not re-use a number
 * that is already public.
 *
 * The unit cases below call findVersionDisagreements() with VALUES, so they
 * describe the relation rather than any particular release number: a correct
 * bump to any future version satisfies them.
 *
 * The last test applies the same function to the REAL files in this checkout --
 * package.json, package-lock.json, capability-defaults/package.json, the engine
 * source package.json resolved through the same binding the packer uses, and
 * the installer identity derived by tools/installer-identity.mjs. That is the
 * one that fails when somebody bumps four of the five places.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertVersionAgreement,
  compareReleaseVersions,
  findVersionDisagreements,
} from '../release-packager/lib/version-agreement.mjs'
import { validatePublishedReleaseLedger } from '../release-packager/lib/published-releases.mjs'
import { identityFromPackageJson } from '../installer-identity.mjs'
import { resolveCapabilitySourceBinding } from '../lib/capability-source-git.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readJson = (...segments) => JSON.parse(readFileSync(path.join(REPO_ROOT, ...segments), 'utf8'))

/* A set of inputs that agrees. Each case below changes exactly one field, so
 * what the case proves is the field it changed and nothing else. */
const AGREEING = Object.freeze({
  appVersion: '2.5.1',
  lockVersion: '2.5.1',
  lockRootVersion: '2.5.1',
  installerIdentityVersion: '2.5.1',
  engineVersion: '9.9.9',
  capabilityDefaultsVersion: '9.9.9',
  publishedVersions: ['2.4.0', '2.5.0'],
})

test('agreeing inputs produce no disagreements at any version number', () => {
  assert.deepEqual(findVersionDisagreements(AGREEING), [])
  assert.equal(assertVersionAgreement(AGREEING), '2.5.1')

  /* The same relation at a completely different number: this is a relation,
     not a pinned literal. */
  assert.deepEqual(
    findVersionDisagreements({
      ...AGREEING,
      appVersion: '77.0.3',
      lockVersion: '77.0.3',
      lockRootVersion: '77.0.3',
      installerIdentityVersion: '77.0.3',
    }),
    [],
  )
})

test('a lock left behind at the old version is named', () => {
  const problems = findVersionDisagreements({ ...AGREEING, lockVersion: '2.5.0' })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].field, 'package-lock.json .version')
  assert.equal(problems[0].expected, '2.5.1')
  assert.equal(problems[0].actual, '2.5.0')
})

test('the lock root entry is checked separately from the lock top level', () => {
  const problems = findVersionDisagreements({ ...AGREEING, lockRootVersion: '2.5.0' })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].field, 'package-lock.json .packages[""].version')
})

test('an installer that would claim a different version than the package is named', () => {
  const problems = findVersionDisagreements({ ...AGREEING, installerIdentityVersion: '2.5.0' })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].field, 'installer identity .version')
})

test('every disagreement is reported, not just the first', () => {
  const problems = findVersionDisagreements({
    ...AGREEING,
    lockVersion: '2.5.0',
    lockRootVersion: '2.5.0',
    installerIdentityVersion: '1.0.0',
  })
  assert.equal(problems.length, 3)
  assert.deepEqual(
    problems.map((problem) => problem.field).sort(),
    [
      'installer identity .version',
      'package-lock.json .packages[""].version',
      'package-lock.json .version',
    ],
  )
})

test('the curated payload manifest must track the engine source, not the app release', () => {
  /* Drifted from the engine: refused. */
  const drifted = findVersionDisagreements({ ...AGREEING, capabilityDefaultsVersion: '9.9.8' })
  assert.equal(drifted.length, 1)
  assert.equal(drifted[0].field, 'capability-defaults/package.json .version')
  assert.equal(drifted[0].expected, '9.9.9')

  /* Set to the APP's release version instead of the engine's: also refused.
     This is the mistake a bump would make if it treated every "version" field
     in the tree as the release number. */
  const followedTheApp = findVersionDisagreements({
    ...AGREEING,
    capabilityDefaultsVersion: AGREEING.appVersion,
  })
  assert.equal(followedTheApp.length, 1)
  assert.equal(followedTheApp[0].field, 'capability-defaults/package.json .version')

  /* And the engine keeping its own line, far from the app's, is CORRECT. */
  assert.deepEqual(
    findVersionDisagreements({ ...AGREEING, engineVersion: '0.1.0', capabilityDefaultsVersion: '0.1.0' }),
    [],
  )
})

test('a version that is already published cannot be cut again', () => {
  const problems = findVersionDisagreements({
    ...AGREEING,
    appVersion: '2.5.0',
    lockVersion: '2.5.0',
    lockRootVersion: '2.5.0',
    installerIdentityVersion: '2.5.0',
  })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].field, 'package.json .version')
  assert.match(problems[0].message, /already recorded as PUBLISHED/)

  /* A version BELOW the published set is a different fault, already covered by
     the downgrade floor in installer-product-identity.test.mjs. It is not a
     collision, so this checker must not claim it as one. */
  assert.deepEqual(
    findVersionDisagreements({
      ...AGREEING,
      appVersion: '2.4.5',
      lockVersion: '2.4.5',
      lockRootVersion: '2.4.5',
      installerIdentityVersion: '2.4.5',
    }),
    [],
  )
})

test('a malformed version is a refusal, never a silent pass', () => {
  for (const bad of ['', '1.0', 'v1.0.0', '1.0.0-rc.1', null, undefined, 42]) {
    const problems = findVersionDisagreements({ ...AGREEING, appVersion: bad })
    assert.ok(
      problems.some((problem) => problem.field === 'package.json .version'),
      `malformed version ${JSON.stringify(bad)} was not refused`,
    )
  }
})

test('compareReleaseVersions orders numerically, not as text', () => {
  assert.ok(compareReleaseVersions('1.0.10', '1.0.9') > 0)
  assert.ok(compareReleaseVersions('1.0.42', '1.0.38') > 0)
  assert.equal(compareReleaseVersions('1.0.42', '1.0.42'), 0)
  assert.throws(() => compareReleaseVersions('1.0', '1.0.0'), /not a major\.minor\.patch/)
})

test('THIS CHECKOUT: every version field agrees and the version is not already published', async () => {
  const appPackage = readJson('package.json')
  const appLock = readJson('package-lock.json')
  const capabilityDefaults = readJson('capability-defaults', 'package.json')

  /* The engine source is resolved the same way tools/pack-capability-layer.mjs
     resolves it, so this compares against the bytes that would actually be
     packed. A source that cannot be resolved is a REFUSAL, not a skip: the
     suite's own entry gate (tools/check-test-inputs.mjs) already requires this
     binding before any test runs, so there is no checkout where skipping here
     would be the honest answer. */
  const { source, sourceRef } = resolveCapabilitySourceBinding({ repoRoot: REPO_ROOT })
  const enginePackage = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))

  const { identity } = await identityFromPackageJson(path.join(REPO_ROOT, 'package.json'))

  const publishedVersions = validatePublishedReleaseLedger(readJson('config', 'shipped-releases.json'))
    .map((release) => release.version)

  const problems = findVersionDisagreements({
    appVersion: appPackage.version,
    lockVersion: appLock.version,
    lockRootVersion: appLock.packages?.['']?.version,
    installerIdentityVersion: identity.version,
    engineVersion: enginePackage.version,
    capabilityDefaultsVersion: capabilityDefaults.version,
    publishedVersions,
  })

  assert.deepEqual(
    problems.map((problem) => problem.message),
    [],
    `capability source ${source} @ ${sourceRef}`,
  )
})
