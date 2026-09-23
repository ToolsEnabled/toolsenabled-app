// Does the provenance gate actually cover the package it stamps?
//
// THE DEFECT THIS PINS: the installer is built from TWO repositories -- this
// one (the Electron app) and a separate engine checkout that
// pack-capability-layer.mjs cuts the 224-file capability payload from.
// require-clean-tree.mjs measured only the first, then wrote `dirty: false`,
// whose stated meaning in its own header is "reproducible from git history
// alone". So a build could truthfully-looking claim clean provenance while its
// larger half was uncommitted, and cut-release-candidate.mjs re-read that claim
// as *independent confirmation* before declaring a release candidate.
//
// A blind spot that reports "unknown" is recoverable. This one reported
// "clean". That is why the payload half is tested here at all: the gate was
// strict on the tree it could see and silent on the tree it could not, and no
// test could tell the difference because there were no tests.
//
// These run real `git` against real scratch repositories rather than stubbing
// it. The thing under test is precisely whether the right DIRECTORY is
// measured, and a stubbed git is exactly the mistake that produced the bug --
// it would have passed against the broken code.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { configuredPayloadSource } from '../require-clean-tree.mjs'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'require-clean-tree.mjs')

test('a busy config read is not reported absent or latched', () => {
  let reads = 0
  const read = () => {
    reads += 1
    if (reads === 1) throw Object.assign(new Error('file table busy'), { code: 'EMFILE' })
    return '{"path":"/payload/recovered"}'
  }

  assert.throws(
    () => configuredPayloadSource(read),
    (error) => error.code === 'PAYLOAD_SOURCE_READ_FAILED' && /NOT claiming .* absent/.test(error.message),
    'EMFILE became the definite answer that the payload setting was absent',
  )
  assert.equal(configuredPayloadSource(read), '/payload/recovered', 'the could-not-tell result was cached or latched')
  assert.equal(reads, 2, 'control: both calls must really read; this module has no legitimate cache to preserve')
})

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${result.stderr || result.stdout}`)
  return result.stdout
}

// Identity is passed per-command so these repos never depend on -- or read --
// the machine's global git config.
function commitAll(cwd, message) {
  git(cwd, ['add', '-A'])
  git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message])
}

function makeRepo(root, files) {
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q'])
  writeFiles(root, files)
  commitAll(root, 'init')
  return root
}

function writeFiles(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

// Returns { exitCode, record } -- record is null when none was written, which
// is itself a thing worth asserting: a refusal must not leave a stale or
// half-written provenance file behind for the next step to read.
function runGate(appRoot, { source, override } = {}) {
  const distDirectory = path.join(appRoot, 'dist')
  const env = { ...process.env }
  delete env.TOOLSENABLED_SOURCE
  delete env.MC_ALLOW_DIRTY_BUILD
  if (source) env.TOOLSENABLED_SOURCE = source
  if (override) env.MC_ALLOW_DIRTY_BUILD = override

  const result = spawnSync(process.execPath, [SCRIPT, distDirectory], {
    cwd: appRoot,
    encoding: 'utf8',
    env,
    windowsHide: true,
  })
  const recordPath = path.join(distDirectory, 'build-info.json')
  let record = null
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    record = null
  }
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, record }
}

// One scratch area per test, torn down after, so a failure in one cannot make
// the next pass or fail for the wrong reason.
function withRepos(run) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mc-rct-'))
  try {
    const payload = makeRepo(path.join(base, 'engine'), {
      'tools/mission-bridge.js': '// marker the packer keys the source tree off\n',
      'src/lib/thing.js': 'module.exports = 1\n',
    })
    const app = makeRepo(path.join(base, 'app'), { 'package.json': '{"name":"app"}\n' })
    run({ app, payload, base })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

/* ---------- the baseline: two clean trees are clean ---------- */

test('both trees clean records dirty:false and BOTH commit refs', () => {
  withRepos(({ app, payload }) => {
    const { exitCode, record } = runGate(app, { source: payload })

    assert.equal(exitCode, 0, 'two clean trees must build')
    assert.equal(record.dirty, false)
    assert.equal(record.overridden, false)

    // The payload ref is new information: before this, build-info.json said
    // nothing at all about which engine commit produced 224 of the shipped
    // files, so a package could not be traced back to that half.
    assert.equal(record.payload.resolved, true, 'the payload tree was not measured')
    assert.equal(record.payload.ref, git(payload, ['rev-parse', 'HEAD']).trim())
    assert.equal(record.app.ref, git(app, ['rev-parse', 'HEAD']).trim())
    assert.notEqual(record.payload.ref, record.app.ref, 'two repos cannot share a commit; the same ref was recorded twice')
  })
})

/* ---------- the regression itself ---------- */

test('a dirty PAYLOAD tree is refused even when the app tree is spotless', () => {
  withRepos(({ app, payload }) => {
    writeFiles(payload, { 'src/lib/thing.js': 'module.exports = 2 // uncommitted\n' })

    const { exitCode, record, stderr } = runGate(app, { source: payload })

    // Before the fix this exited 0 and wrote dirty:false. That is the whole bug.
    assert.equal(exitCode, 1, 'uncommitted payload code was packaged with a clean-provenance claim')
    assert.equal(record, null, 'a refusal must not leave a build-info.json for the next step to trust')
    assert.match(stderr, /src[/\\]lib[/\\]thing\.js/, 'the refusal does not name the file that caused it')
    assert.match(stderr, /payload/, 'the refusal does not say WHICH repository is dirty')
  })
})

test('a dirty payload file is attributed to the payload, not the app', () => {
  withRepos(({ app, payload }) => {
    writeFiles(payload, { 'src/lib/thing.js': 'module.exports = 2\n' })
    const { record } = runGate(app, { source: payload, override: '1' })

    assert.equal(record.dirty, true)
    assert.equal(record.app.dirty, false, 'the app tree is clean and must not be blamed')
    assert.equal(record.payload.dirty, true)
    assert.ok(
      record.dirtyFiles.includes('payload: src/lib/thing.js'),
      `the merged list must namespace its paths, got ${JSON.stringify(record.dirtyFiles)}`,
    )
    // Both repos contain a src/ and a tools/. An unlabelled path sends the
    // reader to the wrong checkout, which is worse than no list.
    assert.ok(
      record.dirtyFiles.every((entry) => /^(app|payload): /.test(entry)),
      'an unnamespaced path is ambiguous between two trees',
    )
  })
})

/* ---------- unknown is not clean ---------- */

test('an unresolvable payload tree is refused rather than assumed clean', () => {
  withRepos(({ app, base }) => {
    const { exitCode, record, stderr } = runGate(app, { source: path.join(base, 'does-not-exist') })

    assert.equal(exitCode, 1, 'a payload tree that could not be measured was treated as clean')
    assert.equal(record, null)
    assert.match(stderr, /UNRESOLVED/, 'the refusal does not say the payload could not be measured')
  })
})

test('a payload path that is not a git checkout is refused', () => {
  withRepos(({ app, base }) => {
    // Looks like the right tree (has the marker the packer keys off) but has
    // no history, so nothing about it is reproducible.
    const notARepo = path.join(base, 'loose')
    mkdirSync(path.join(notARepo, 'tools'), { recursive: true })
    writeFileSync(path.join(notARepo, 'tools', 'mission-bridge.js'), '// marker\n')

    const { exitCode, record } = runGate(app, { source: notARepo })
    assert.equal(exitCode, 1, 'a payload source with no git history was accepted')
    assert.equal(record, null)
  })
})

/* ---------- the override broadcasts, it does not silence ---------- */

test('the override ships the payload file list inside the artifact', () => {
  withRepos(({ app, payload }) => {
    writeFiles(payload, { 'src/lib/thing.js': 'x\n', 'src/lib/second.js': 'y\n' })
    const { exitCode, record, stderr } = runGate(app, { source: payload, override: '1' })

    assert.equal(exitCode, 0, 'the named override must still allow a deliberate dirty build')
    assert.equal(record.overridden, true, 'an overridden build that records overridden:false is indistinguishable from a clean one')
    assert.equal(record.dirty, true)
    assert.ok(record.payload.dirtyFiles.includes('src/lib/second.js'))
    assert.match(stderr, /NOT reproducible/, 'the override must warn on the console as well as in the file')
  })
})

test('only the exact override value opens the gate', () => {
  withRepos(({ app, payload }) => {
    writeFiles(payload, { 'src/lib/thing.js': 'x\n' })
    // "true" is the plausible near-miss someone sets by hand. A gate that
    // accepts anything truthy is a gate that opens by accident.
    assert.equal(runGate(app, { source: payload, override: 'true' }).exitCode, 1)
    assert.equal(runGate(app, { source: payload, override: '0' }).exitCode, 1)
  })
})

/* ---------- the record still carries no builder identity ---------- */

test('build-info.json records no absolute path, username, or hostname', () => {
  withRepos(({ app, payload }) => {
    writeFiles(payload, { 'src/lib/thing.js': 'x\n' })
    const { record } = runGate(app, { source: payload, override: '1' })
    const serialised = JSON.stringify(record)

    // The payload root is an absolute path that names the builder and their
    // machine layout -- which is exactly why the file configuring it is
    // untracked. Its commit SHA and repo-relative paths carry the provenance
    // without carrying the identity.
    //
    // THE NEEDLE MUST BE JSON-ENCODED, AND THIS ASSERTION WAS DEAD WITHOUT IT.
    // It read `!serialised.includes(payload)` with `payload` a raw Windows
    // path. JSON.stringify escapes every backslash, so the haystack holds
    // `C:\\Users\\...` while the needle holds `C:\Users\...` -- includes() is
    // false even when the path is right there, and the assertion passed on a
    // record that leaked. A guard that cannot fail is worse than no guard: it
    // occupies the slot where a real one would go. Caught by another lane
    // reusing this file as a model, and verified here before changing it.
    const encoded = (value) => JSON.stringify(value).slice(1, -1)
    assert.ok(!serialised.includes(encoded(payload)), 'the payload tree absolute path was recorded')
    assert.ok(!serialised.includes(encoded(app)), 'the app tree absolute path was recorded')
    assert.doesNotMatch(serialised, /[A-Za-z]:\\\\|\/Users\/|\/home\//, 'an absolute path leaked into the shipped record')
    // An account named "j" also appears in the legitimate suffix ".js".
    // Pin the entire permitted record instead of matching identity substrings
    // inside unrelated field names or repository-relative paths.
    assert.match(record.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const appRef = git(app, ['rev-parse', 'HEAD']).trim()
    const payloadRef = git(payload, ['rev-parse', 'HEAD']).trim()
    assert.deepEqual(record, {
      schemaVersion: 2, dirty: true, overridden: true, ref: appRef,
      checkedAt: record.checkedAt, dirtyFiles: ['payload: src/lib/thing.js'],
      app: { ref: appRef, dirty: false, dirtyFiles: [] },
      payload: { resolved: true, ref: payloadRef, dirty: true, dirtyFiles: ['src/lib/thing.js'] },
    }, 'only timestamp, repository refs, status and relative dirty paths may be shipped')
  })
})
