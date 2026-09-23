import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { verifyVersionTransition, verifyVersionTransitionRefs } from '../release-packager/verify-version-transition.mjs'

const CUTTER = readFileSync(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url), 'utf8')

const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')

function fixtures() {
  const sourcePackageValue = {
    name: 'toolsenabled',
    version: '1.0.39',
    private: true,
    dependencies: { alpha: '1.0.0' },
    scripts: { test: 'node --test' },
  }
  const sourceLockValue = {
    name: 'toolsenabled',
    version: '1.0.39',
    lockfileVersion: 3,
    packages: {
      '': { name: 'toolsenabled', version: '1.0.39', dependencies: { alpha: '1.0.0' } },
      'node_modules/alpha': { version: '1.0.0' },
    },
  }
  return {
    sourcePackage: bytes(sourcePackageValue),
    buildPackage: bytes({ ...sourcePackageValue, version: '1.0.40' }),
    sourceLock: bytes(sourceLockValue),
    buildLock: bytes({
      ...sourceLockValue,
      version: '1.0.40',
      packages: {
        ...sourceLockValue.packages,
        '': { ...sourceLockValue.packages[''], version: '1.0.40' },
      },
    }),
    version: '1.0.40',
  }
}

test('accepts the exact two-file version-only rewrite', () => {
  assert.equal(verifyVersionTransition(fixtures()), true)
})

test('rejects any package.json change beyond the root version', () => {
  const values = fixtures()
  values.buildPackage = bytes({
    name: 'toolsenabled',
    version: '1.0.40',
    private: false,
    scripts: { test: 'node --test' },
  })
  assert.throws(() => verifyVersionTransition(values), /package\.json differs/)
})

test('rejects any package-lock.json change beyond the two intended version fields', () => {
  const values = fixtures()
  const changed = JSON.parse(values.buildLock.toString('utf8'))
  changed.packages['node_modules/alpha'].version = '2.0.0'
  values.buildLock = bytes(changed)
  assert.throws(() => verifyVersionTransition(values), /package-lock\.json differs/)
})

test('rejects byte-format drift even when parsed values match', () => {
  const values = fixtures()
  values.buildPackage = Buffer.from(values.buildPackage.toString('utf8').trimEnd(), 'utf8')
  assert.throws(() => verifyVersionTransition(values), /package\.json differs/)
})

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function topologyFixture({ extraPath = false } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'version-transition-'))
  git(repo, 'init', '--quiet')
  git(repo, 'config', 'user.name', 'Version Transition Test')
  git(repo, 'config', 'user.email', 'version-transition@example.invalid')
  const values = fixtures()
  writeFileSync(path.join(repo, 'package.json'), values.sourcePackage)
  writeFileSync(path.join(repo, 'package-lock.json'), values.sourceLock)
  git(repo, 'add', 'package.json', 'package-lock.json')
  git(repo, 'commit', '--quiet', '-m', 'source')
  const sourceRef = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(path.join(repo, 'package.json'), values.buildPackage)
  writeFileSync(path.join(repo, 'package-lock.json'), values.buildLock)
  if (extraPath) writeFileSync(path.join(repo, 'extra.txt'), 'scope creep\n')
  git(repo, 'add', '--all')
  git(repo, 'commit', '--quiet', '-m', 'version only')
  const buildRef = git(repo, 'rev-parse', 'HEAD')
  return { repo, sourceRef, buildRef }
}

test('accepts only a direct single-parent version commit with the exact two changed paths', () => {
  const fixture = topologyFixture()
  try {
    assert.equal(verifyVersionTransitionRefs(fixture), true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('rejects a version commit that changes a third path', () => {
  const fixture = topologyFixture({ extraPath: true })
  try {
    assert.throws(() => verifyVersionTransitionRefs(fixture), /must change exactly package\.json and package-lock\.json/)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('rejects a merge build even when its tree contains the exact version rewrite', () => {
  const fixture = topologyFixture()
  try {
    const versionTree = git(fixture.repo, 'rev-parse', `${fixture.buildRef}^{tree}`)
    const sibling = git(fixture.repo, 'commit-tree', `${fixture.sourceRef}^{tree}`, '-p', fixture.sourceRef, '-m', 'sibling')
    const merge = git(fixture.repo, 'commit-tree', versionTree, '-p', fixture.sourceRef, '-p', sibling, '-m', 'merge build')
    assert.throws(
      () => verifyVersionTransitionRefs({ ...fixture, buildRef: merge }),
      /single-parent commit whose direct parent is sourceRef/,
    )
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('rejects a single-parent build whose parent is not sourceRef', () => {
  const fixture = topologyFixture()
  try {
    const olderSource = git(fixture.repo, 'commit-tree', `${fixture.sourceRef}^{tree}`, '-m', 'unrelated source')
    assert.throws(
      () => verifyVersionTransitionRefs({ ...fixture, sourceRef: olderSource }),
      /single-parent commit whose direct parent is sourceRef/,
    )
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

function runVerifier(fixture, { sourceRef = fixture.buildRef, buildRef = fixture.buildRef, version = '1.0.40', flags = [] } = {}) {
  return spawnSync(process.execPath, [
    fileURLToPath(new URL('../release-packager/verify-version-transition.mjs', import.meta.url)),
    '--repo', fixture.repo, '--source-ref', sourceRef, '--build-ref', buildRef, '--version', version,
    ...flags,
  ], { encoding: 'utf8', windowsHide: true })
}

test('the real verifier admits unchanged committed source only with explicit same-version consent and leaves Git unchanged', () => {
  const fixture = topologyFixture()
  try {
    const before = git(fixture.repo, 'rev-parse', 'HEAD')
    const refused = runVerifier(fixture)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /requires explicit --allow-same-version/)
    const accepted = runVerifier(fixture, { flags: ['--allow-same-version'] })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /explicit unchanged source; committed package\/lock parity verified/)
    assert.equal(git(fixture.repo, 'rev-parse', 'HEAD'), before)
    assert.equal(git(fixture.repo, 'status', '--porcelain'), '')
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('same-version consent cannot accept an incorrect declared version or an invented empty child commit', () => {
  const fixture = topologyFixture()
  try {
    const wrongVersion = runVerifier(fixture, { version: '1.0.44', flags: ['--allow-same-version'] })
    assert.equal(wrongVersion.status, 1)
    assert.match(wrongVersion.stderr, /already carry the requested version/)
    git(fixture.repo, 'commit', '--allow-empty', '--quiet', '-m', 'empty child')
    const emptyRef = git(fixture.repo, 'rev-parse', 'HEAD')
    const empty = runVerifier(fixture, { buildRef: emptyRef, flags: ['--allow-same-version'] })
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /must change exactly package.json and package-lock.json/)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('same-version verification checks all committed package fields and dependency parity', () => {
  const fixture = topologyFixture()
  try {
    const original = readFileSync(path.join(fixture.repo, 'package-lock.json'), 'utf8')
    for (const mutation of ['top-version', 'root-version', 'dependency']) {
      const lock = JSON.parse(original)
      if (mutation === 'top-version') lock.version = '1.0.39'
      if (mutation === 'root-version') lock.packages[''].version = '1.0.39'
      if (mutation === 'dependency') lock.packages[''].dependencies.alpha = '2.0.0'
      writeFileSync(path.join(fixture.repo, 'package-lock.json'), bytes(lock))
      git(fixture.repo, 'add', 'package-lock.json')
      git(fixture.repo, 'commit', '--quiet', '-m', mutation)
      const ref = git(fixture.repo, 'rev-parse', 'HEAD')
      const result = runVerifier(fixture, { sourceRef: ref, buildRef: ref, flags: ['--allow-same-version'] })
      assert.equal(result.status, 1, mutation)
      assert.match(result.stderr, mutation === 'dependency' ? /parity failed/ : /all three package fields/)
    }
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('same-version flag neither relaxes changed-path scope nor accepts repeated flags', () => {
  const fixture = topologyFixture({ extraPath: true })
  try {
    const changed = runVerifier(fixture, { sourceRef: fixture.sourceRef, flags: ['--allow-same-version'] })
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /must change exactly package.json and package-lock.json/)
    const repeated = runVerifier(fixture, { flags: ['--allow-same-version', '--allow-same-version'] })
    assert.equal(repeated.status, 1)
    assert.match(repeated.stderr, /only once/)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('the real cutter invokes the exact transition verifier before any build starts', () => {
  const invoke = CUTTER.indexOf("'tools/release-packager/verify-version-transition.mjs'")
  const verified = CUTTER.indexOf("exact version-only commit transition: verified", invoke)
  const dist = CUTTER.indexOf("['run', 'dist']", verified)
  assert.ok(invoke >= 0 && verified > invoke && dist > verified,
    'the version-transition verifier is no longer a pre-build gate in the actual cutter')
  const block = CUTTER.slice(invoke, verified)
  for (const argument of ["'--repo', repo", "'--source-ref', sourceRef", "'--build-ref', buildRef", "'--version', version"]) {
    assert.match(block, new RegExp(argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), argument)
  }
})
