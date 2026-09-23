// Does the artifact seal actually refuse a contaminated artifact?
//
// tools/seal-artifact.mjs exists because `npm run dist` was contaminating the
// artifact it had already certified: its last two steps start the packaged
// application against release/win-unpacked, and check-payload-boundary ran
// before them, so a bearer token and the audit ledger appeared in the build
// AFTER every gate had gone green. The seal is the detection half of that fix.
//
// A gate nothing tests can stop guarding silently while the build keeps
// printing green -- and this particular gate's whole purpose is to be the thing
// that notices. So these assertions RUN the tool and read its real exit code
// rather than reading its source: a source assertion cannot tell live code from
// dead code, and "it looked right" is how the defect got here.
//
// The two that matter most are the fail-closed ones. A verify with no seal to
// compare against has checked nothing, and must never render that as
// "unchanged" -- same rule the owner-data guard learned in
// tools/pack-capability-layer.mjs: unchecked is not clean.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'seal-artifact.mjs')

// T385: a real artifact states the commit it was built from (dist/.dist-source.json,
// packed into resources/app.asar). A synthetic artifact states it under
// resources/app/dist/, and MC_SEAL_SOURCE_HEAD injects the matching source head so
// the seal binds without a real cut worktree. The injection never disables the
// built-vs-source refusal (a mismatching head still refuses -- see the T385
// mutation script), it only supplies the head to compare against here.
const TEST_BUILT_SHA = ''.padEnd(40, 'a')

function run(mode, directory) {
  const result = spawnSync(process.execPath, [TOOL, mode, directory],
    { encoding: 'utf8', env: { ...process.env, MC_SEAL_SOURCE_HEAD: TEST_BUILT_SHA, MC_SEAL_SOURCE_CLEAN: '1' } })
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

function scaffold() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mc-seal-'))
  const artifact = path.join(base, 'win-unpacked')
  mkdirSync(path.join(artifact, 'resources', 'capability'), { recursive: true })
  writeFileSync(path.join(artifact, 'ToolsEnabled.exe'), 'binary\n')
  writeFileSync(path.join(artifact, 'resources', 'capability', 'PAYLOAD.json'), '{"payload":true}\n')
  mkdirSync(path.join(artifact, 'resources', 'app', 'dist'), { recursive: true })
  writeFileSync(path.join(artifact, 'resources', 'app', 'dist', '.dist-source.json'),
    JSON.stringify({ schemaVersion: 1, appHead: TEST_BUILT_SHA }) + '\n')
  return { base, artifact, seal: path.join(base, '.artifact-seal-win-unpacked.json') }
}

test('records the seal beside the artifact, never inside it', () => {
  const { base, artifact, seal } = scaffold()
  try {
    const recorded = run('--record', artifact)
    assert.equal(recorded.status, 0, recorded.output)
    assert.ok(existsSync(seal), `expected a seal at ${seal}\n${recorded.output}`)

    // A seal written INSIDE the artifact would be a file the build did not
    // produce -- the check would become its own first offender, and the seal
    // would be sealing itself. Verify must therefore still pass right after
    // record, which it cannot do if recording mutated the tree.
    const verified = run('--verify', artifact)
    assert.equal(verified.status, 0, verified.output)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('refuses a planted runtime-state file and names it', () => {
  const { base, artifact } = scaffold()
  try {
    assert.equal(run('--record', artifact).status, 0)

    // Mutation sentinel: dropping compare()'s added.push(relative) must make
    // this assertion fail. Otherwise a green run has not exercised the guard.
    // The measured contamination: a live mission-bridge bearer token written
    // into the shipped payload by the chain's own smoke step.
    const state = path.join(artifact, 'resources', 'capability', 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(path.join(state, 'mission-bridge-token.json'), '{"token":"planted"}\n')

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `expected refusal, got ${status}\n${output}`)
    assert.match(output, /resources\/capability\/state\/mission-bridge-token\.json/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('refuses an audit database', () => {
  const { base, artifact } = scaffold()
  try {
    assert.equal(run('--record', artifact).status, 0)
    writeFileSync(path.join(artifact, 'resources', 'capability', 'audit.sqlite3'), 'SQLite format 3\0')

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `expected refusal, got ${status}\n${output}`)
    assert.match(output, /audit\.sqlite3/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// THE POINT OF A SEAL RATHER THAN A LIST OF FORBIDDEN NAMES. A name list only
// catches contamination someone already thought of. This addition is not
// runtime state by any rule the tool knows, and it must still fail: the
// requirement is that a finished artifact is finished, not that it avoids a
// particular set of filenames.
test('refuses an addition that is not runtime state at all', () => {
  const { base, artifact } = scaffold()
  try {
    assert.equal(run('--record', artifact).status, 0)
    writeFileSync(path.join(artifact, 'something-nobody-predicted.dat'), 'surprise\n')

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `expected refusal, got ${status}\n${output}`)
    assert.match(output, /something-nobody-predicted\.dat/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('refuses a modified file and a deleted file', () => {
  const { base, artifact } = scaffold()
  try {
    assert.equal(run('--record', artifact).status, 0)
    writeFileSync(path.join(artifact, 'ToolsEnabled.exe'), 'tampered\n')
    rmSync(path.join(artifact, 'resources', 'capability', 'PAYLOAD.json'))

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `expected refusal, got ${status}\n${output}`)
    assert.match(output, /ToolsEnabled\.exe/)
    assert.match(output, /PAYLOAD\.json/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---- fail-closed: a verify that compared nothing must say so, not pass.
//
// The realistic route to each of these is someone reordering the dist chain so
// --verify loses its --record. That is exactly the mistake the tool has to
// shout about, because the silent version of it reinstates the original defect
// with a green tick on top.

test('fails closed when the seal is missing', () => {
  const { base, artifact, seal } = scaffold()
  try {
    assert.equal(run('--record', artifact).status, 0)
    rmSync(seal)

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `a verify with no seal must fail, got ${status}\n${output}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('fails closed when the seal is malformed', () => {
  const { base, artifact, seal } = scaffold()
  try {
    assert.equal(run('--record', artifact).status, 0)
    writeFileSync(seal, 'not json at all\n')

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `a verify with an unreadable seal must fail, got ${status}\n${output}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// A seal recorded against a different directory would otherwise compare this
// tree to a stranger's manifest and emit a torrent of meaningless differences,
// which reads as a broken check -- and a check that looks broken gets disabled.
test('fails closed when the seal belongs to another artifact', () => {
  const { base, artifact, seal } = scaffold()
  try {
    const other = path.join(base, 'other-unpacked')
    mkdirSync(path.join(other, 'resources', 'app', 'dist'), { recursive: true })
    writeFileSync(path.join(other, 'other.txt'), 'other\n')
    // T385: like any sealable artifact, this one states the commit it was built from.
    writeFileSync(path.join(other, 'resources', 'app', 'dist', '.dist-source.json'),
      JSON.stringify({ schemaVersion: 1, appHead: TEST_BUILT_SHA }) + '\n')
    assert.equal(run('--record', other).status, 0)

    copyFileSync(path.join(base, '.artifact-seal-other-unpacked.json'), seal)

    const { status, output } = run('--verify', artifact)
    assert.equal(status, 1, `a seal for another artifact must fail, got ${status}\n${output}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---- the seal must not itself put the build machine in the release directory.
//
// MEASURED, 2026-08-11. `artifact` held path.resolve(artifactDirectory), so
// every --record wrote the builder's home directory into
// release/.artifact-seal-win-unpacked.json:
//
//   "artifact": "C:\\Users\\<builder>\\Desktop\\wt-capability\\release\\win-unpacked"
//
// `node tools/check-no-owner-data.mjs` failed on it under the built-in `C:\Users`
// rule, which is never excusable. The ordering is what made it survivable for so
// long: tools/strip-build-diagnostics.mjs sweeps release/ immediately after
// electron-builder, and --record runs several steps LATER, so the sweep could
// not have caught it and a fully green build still ended with the leak on disk.
//
// This asserts the FILE THAT IS WRITTEN, not the source that writes it, because
// the whole failure was that the writing looked reasonable in isolation.
test('records no absolute path, so the build machine is not left in the release directory', () => {
  const { base, artifact, seal } = scaffold()
  try {
    const recorded = run('--record', artifact)
    assert.equal(recorded.status, 0, recorded.output)

    const parsed = JSON.parse(readFileSync(seal, 'utf8'))
    const strings = []
    JSON.stringify(parsed, (_key, value) => {
      if (typeof value === 'string') strings.push(value)
      return value
    })
    const absolutePaths = strings.filter((value) => path.isAbsolute(value) || path.win32.isAbsolute(value))
    assert.deepEqual(absolutePaths, [], `the seal records absolute path(s): ${JSON.stringify(absolutePaths)}`)

    // The identity must still be recorded, and must still be enough to verify.
    // A seal that dropped the field entirely would pass every assertion above
    // and destroy the wrong-artifact guard the next test covers.
    assert.equal(run('--verify', artifact).status, 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('refuses a directory that does not exist, and rejects a bad mode', () => {
  const { base, artifact } = scaffold()
  try {
    const missing = run('--verify', path.join(base, 'no-such-artifact'))
    assert.equal(missing.status, 1, missing.output)

    const badMode = spawnSync(process.execPath, [TOOL, '--sniff', artifact], { encoding: 'utf8' })
    assert.equal(badMode.status, 1, `${badMode.stdout}${badMode.stderr}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
