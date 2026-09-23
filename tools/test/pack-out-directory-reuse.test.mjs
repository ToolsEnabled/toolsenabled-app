// THE PACKER MUST NOT DELETE ITS OWN DESTINATION ROOT.
//
// Measured on Windows, 2026-08-11: with a `codex exec --cd <this tree>` process
// running, `rmdir(capability)` fails EBUSY -- but removing all eight children
// individually SUCCEEDS, leaving the root in place and empty. The lock is on the
// directory OBJECT, not on its contents. Any agent working in this tree, any
// editor with the folder open, any shell whose cwd is inside it takes that lock,
// so `npm run dist` failed before writing a byte for reasons that had nothing to
// do with the build.
//
// "Empty the directory, keep the directory" reaches an identical end state and is
// immune to the lock. This test pins that, and it pins it BEHAVIOURALLY: a source
// scan for `rmSync(out` would pass against dead code just as happily as live code.
// birthtime is the evidence -- if the packer ever recreates the root, the
// directory object is new and its creation timestamp moves.

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKER = path.join(REPO, 'tools', 'pack-capability-layer.mjs')
const SOURCE_SETTING = path.join(REPO, 'private', 'capability-source.owner.json')

let fixtureSource = null
let fixtureSourceRef = null
let fixtureAppRoot = null

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function directoryBehaviorSource() {
  if (fixtureSource) return fixtureSource

  const configured = JSON.parse(readFileSync(SOURCE_SETTING, 'utf8')).path
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pack-source-'))
  fixtureSource = path.join(fixtureRoot, 'source')
  fixtureAppRoot = path.join(fixtureRoot, 'app')

  // The installed app's private source pin is a real release invariant, not
  // fixture state. Give the exact production packer its own app root, with
  // unchanged manifest/defaults/owner-data guard inputs and a matching fixture
  // binding. Do not edit the production owner file or loosen its ref checks.
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  for (const relative of [
    'tools/pack-capability-layer.mjs',
    'tools/lib/capability-source-git.mjs',
    'tools/lib/capability-index-check.mjs',
    'tools/lib/provider-runtime-payload.mjs',
    'tools/lib/sterile-launch.cjs',
    'shell/install-profile-guard.cjs',
    'shell/capability-path-environment.cjs',
    'package.json',
    'tools/check-no-owner-data.mjs',
    'tools/capability-manifest.json',
    'private/owner-data-patterns.owner.json',
    ...manifest.neutralDefaults.map(relative => `capability-defaults/${relative}`),
  ]) {
    const target = path.join(fixtureAppRoot, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(REPO, relative), target)
  }

  // The production packer deliberately accepts only one clean, exact Git
  // commit. Give this behavioural test the same kind of input instead of
  // weakening that release invariant or relying on a dirty copied worktree.
  git(['clone', '--quiet', '--no-local', configured, fixtureSource])
  writeFileSync(
    path.join(fixtureSource, 'tools', 'windows-job-wrapper.ps1'),
    '# Fixture helper: this suite exercises destination-directory reuse only.\n',
  )
  git(['-C', fixtureSource, 'config', 'user.name', 'ToolsEnabled Test'])
  git(['-C', fixtureSource, 'config', 'user.email', 'test@example.invalid'])
  git(['-C', fixtureSource, 'add', '--all'])
  git(['-C', fixtureSource, 'commit', '--quiet', '--no-gpg-sign', '-m', 'Build pack-directory test fixture'])
  fixtureSourceRef = git(['-C', fixtureSource, 'rev-parse', '--verify', 'HEAD^{commit}']).trim()
  // Keep the private declaration active: it must agree with the explicit
  // fixture pin, just as it must for the real release.
  writeFileSync(path.join(fixtureAppRoot, 'private/capability-source.owner.json'),
    JSON.stringify({ path: fixtureSource, ref: fixtureSourceRef }))
  return fixtureSource
}

async function pack(out) {
  // --allow-owner-data because this suite tests DIRECTORY BEHAVIOUR, not payload
  // compliance. The guard correctly refuses to stage from a source tree that still
  // carries the builder's name and paths, so without this flag these tests fail on a
  // real, correct refusal that has nothing to do with what they assert. The flag does
  // not weaken the ship path: npm run dist re-runs the same guard over the built
  // release, where it is the compliance check rather than a fixture precondition.
  const source = directoryBehaviorSource()
  // The release cutter deliberately pins the real engine in these ambient
  // variables for `npm run dist`. This test deliberately supplies a different,
  // isolated fixture through explicit argv. Letting the ambient production pin
  // leak into that child makes two honest declarations disagree and prevents the
  // release suite from testing directory reuse at all. Explicit argv and the
  // isolated builder's matching private pin bind this fixture process.
  const fixtureEnvironment = { ...process.env }
  delete fixtureEnvironment.TOOLSENABLED_SOURCE
  delete fixtureEnvironment.TOOLSENABLED_SOURCE_REF
  const fixturePacker = path.join(fixtureAppRoot, 'tools', 'pack-capability-layer.mjs')
  assert.equal(readFileSync(fixturePacker, 'utf8'), readFileSync(PACKER, 'utf8'),
    'directory behavior must be exercised through the exact production packer')
  return run(
    process.execPath,
    [fixturePacker, '--source', source, '--source-ref', fixtureSourceRef, '--out', out, '--quiet', '--allow-owner-data'],
    { cwd: fixtureAppRoot, env: fixtureEnvironment, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
}

process.on('exit', () => {
  if (fixtureSource) rmSync(path.dirname(fixtureSource), { recursive: true, force: true })
})

test('the destination root survives -- it is emptied, never recreated', async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'pack-reuse-')), 'capability')
  try {
    mkdirSync(out, { recursive: true })
    const before = statSync(out).birthtimeMs

    await pack(out)
    const after = statSync(out).birthtimeMs

    assert.equal(
      after,
      before,
      'the destination directory was recreated -- its birthtime moved. A recreate needs rmdir on the ' +
        'root, which fails EBUSY whenever anything holds that directory open, and the build dies there.',
    )
  } finally {
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})

test('a stale file left in the destination does not survive the next stage', async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'pack-stale-')), 'capability')
  try {
    mkdirSync(path.join(out, 'nested'), { recursive: true })
    const loose = path.join(out, 'REMOVED-FROM-THE-PAYLOAD.js')
    const nested = path.join(out, 'nested', 'also-gone.js')
    writeFileSync(loose, '// a file a previous cut staged and this one must not\n')
    writeFileSync(nested, '// same, one level down\n')

    await pack(out)

    assert.ok(!existsSync(loose), 'a stale file at the top level was carried into the new stage')
    assert.ok(!existsSync(nested), 'a stale nested directory was carried into the new stage')
    assert.ok(readdirSync(out).length > 0, 'the packer emptied the destination and then staged nothing')
  } finally {
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})

test('a conflicting owner binding refuses before the destination is emptied', async () => {
  const source = directoryBehaviorSource()
  const binding = path.join(fixtureAppRoot, 'private', 'capability-source.owner.json')
  const previousBinding = readFileSync(binding)
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'pack-ref-conflict-')), 'capability')
  try {
    mkdirSync(out)
    const sentinel = path.join(out, 'must-survive.txt')
    writeFileSync(sentinel, 'the previous valid payload\n')
    const before = statSync(out).birthtimeMs
    const otherRef = (fixtureSourceRef[0] === '0' ? '1' : '0') + fixtureSourceRef.slice(1)
    writeFileSync(binding, `${JSON.stringify({ path: source, ref: otherRef })}\n`)
    await assert.rejects(pack(out), error => {
      assert.match(String(error.stderr), /source ref declarations disagree/)
      return true
    }, 'the fixture must not bypass conflicting exact source declarations')
    assert.equal(statSync(out).birthtimeMs, before)
    assert.equal(readFileSync(sentinel, 'utf8'), 'the previous valid payload\n',
      'a provenance refusal must happen before any destination contents change')
  } finally {
    writeFileSync(binding, previousBinding)
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})
