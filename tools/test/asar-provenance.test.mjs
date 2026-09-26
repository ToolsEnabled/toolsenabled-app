/* AN ARCHIVE MUST BE ABLE TO SAY WHAT IT IS.
 *
 * THE DEFECT THIS EXISTS FOR, measured on 2026-08-11. The installed
 * application did not contain that night's port-keyed-storage fix. Scanned for
 * the fix's own identifiers, the shipped app.asar had renderer-prefs.json 0,
 * createRendererPrefs 0, durable-storage 0, mcPrefs 0, drainedOrigins 0,
 * MC_PREFS_WRITE_FAILED 0, preferredPortFirst 0 -- while the control string
 * shell-state.json appeared once, proving the scan worked on that file. The fix
 * greps as present in the checkout and is absent from the thing a customer
 * installs.
 *
 * Nothing could see the gap. require-clean-tree.mjs writes dist/build-info.json
 * and its header promises the record "ships inside the package -- inspectable by
 * anyone holding only the .exe". It was absent from ALL THREE app.asar files on
 * the build machine. The promise was kept by no artifact, because the record is
 * only written when that gate RUNS, and `electron-builder --win nsis` invoked
 * directly produces a complete installer without it. Every downstream gate --
 * this one, check-no-owner-data, check-license-notices, check-payload-boundary,
 * smoke-packaged -- passed such an archive, because not one of them asked.
 *
 * So an ungated build was indistinguishable from a gated one: an absence read as
 * consent, in the release layer.
 *
 * WHY THESE TESTS BUILD REAL ARCHIVES. The defect lives in packaged bytes, not
 * in a function's arguments, and a test that only called judgeProvenance() would
 * pass just as happily if nothing ever read the archive. So the end-to-end cases
 * write genuine asar containers -- the documented layout, four little-endian
 * header words, the JSON directory, 4-byte-aligned file bytes -- and run the
 * real CLI against them as a subprocess, asserting on what it printed and the
 * status it exited with.
 *
 * WHY THEY ASSERT ON THE NAMED REFUSAL AND NOT ONLY ON THE EXIT CODE. A
 * synthetic archive cannot contain every file the real package.json declares, so
 * it fails the declared-files check for unrelated reasons and exit 1 alone would
 * prove nothing about provenance. Each case therefore asserts that the specific
 * provenance sentence is present or absent. Where a verdict IS unambiguous --
 * an archive with no record at all can never be OK -- the exit code is asserted
 * too.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROVENANCE_ENTRY, judgeProvenance } from '../check-asar-manifest.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-asar-manifest.mjs')

/* The sentence the gate must say when an archive carries no provenance. Matched
   on the load-bearing clause rather than the whole paragraph, so rewording the
   explanation does not red the test, but deleting the check does. */
const NO_PROVENANCE = /contains no dist[\\/]build-info\.json/

/* Write a real asar container. Mirrors the layout check-asar-manifest.mjs
   reads -- and the one electron-builder writes -- rather than a shape invented
   to satisfy the reader: four UInt32LE words, then the JSON directory at offset
   16, then the file bytes at 4-byte alignment from the padded end of the JSON. */
function writeAsar(target, files) {
  const bodies = []
  let offset = 0
  const root = { files: {} }
  for (const [relative, contents] of Object.entries(files)) {
    const bytes = Buffer.from(contents, 'utf8')
    let node = root
    const parts = relative.split('/')
    for (const directory of parts.slice(0, -1)) {
      node.files[directory] ??= { files: {} }
      node = node.files[directory]
    }
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) }
    bodies.push(bytes)
    offset += bytes.length
  }

  const json = Buffer.from(JSON.stringify(root), 'utf8')
  const aligned = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(16 + aligned)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(aligned + 8, 4)
  header.writeUInt32LE(aligned + 4, 8)
  header.writeUInt32LE(json.length, 12)
  json.copy(header, 16)
  writeFileSync(target, Buffer.concat([header, ...bodies]))
}

/* An unpacked build directory shaped the way electron-builder leaves one, so
   the gate walks the same paths it walks in the ship chain. */
function stageBuild(archiveFiles) {
  const root = mkdtempSync(path.join(tmpdir(), 'te-asar-provenance-'))
  const resources = path.join(root, 'resources')
  const capability = path.join(resources, 'capability')
  mkdirSync(capability, { recursive: true })
  writeFileSync(path.join(capability, 'bridge.js'), '// staged payload entrypoint\n')
  writeFileSync(
    path.join(capability, 'PAYLOAD.json'),
    JSON.stringify({ bridgeEntrypoint: 'bridge.js', fileCount: 1, hostModules: [], ownerDataClean: true }),
  )
  writeAsar(path.join(resources, 'app.asar'), archiveFiles)
  return root
}

function runGate(buildDirectory, environment = {}) {
  const env = { ...process.env }
  delete env.MC_ALLOW_DIRTY_BUILD
  Object.assign(env, environment)
  const result = spawnSync(process.execPath, [GATE, buildDirectory], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    windowsHide: true,
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

const APP_PACKAGE = JSON.stringify({ name: 'toolsenabled', main: 'shell/main.cjs' })
const CLEAN_RECORD = {
  schemaVersion: 2,
  dirty: false,
  overridden: false,
  ref: '0'.repeat(40),
  checkedAt: '2026-08-11T04:00:00.000Z',
  dirtyFiles: [],
  app: { ref: '0'.repeat(40), dirty: false, dirtyFiles: [] },
  payload: { resolved: true, ref: '1'.repeat(40), dirty: false, dirtyFiles: [] },
}

function buildWith(record) {
  const files = { 'package.json': APP_PACKAGE, 'shell/main.cjs': '// entry\n' }
  if (record !== undefined) files[PROVENANCE_ENTRY] = typeof record === 'string' ? record : JSON.stringify(record)
  return stageBuild(files)
}

test('an archive with no provenance record is refused, not passed over in silence', () => {
  const build = buildWith(undefined)
  try {
    const { status, output } = runGate(build)
    assert.match(
      output,
      NO_PROVENANCE,
      'A packaged archive carrying no dist/build-info.json was accepted without comment. That is the shipped-installer defect: '
        + 'a build produced off the dist chain, with require-clean-tree never run, is then indistinguishable from a gated one.',
    )
    assert.equal(
      status,
      1,
      'An archive that cannot state which commit it came from must fail. Nothing downstream re-asks this question, '
        + 'so a zero exit here is the last chance to notice and it is spent.',
    )
  } finally {
    rmSync(build, { recursive: true, force: true })
  }
})

test('an archive that states a clean commit is not accused of missing provenance', () => {
  const build = buildWith(CLEAN_RECORD)
  try {
    const { output } = runGate(build)
    assert.doesNotMatch(
      output,
      NO_PROVENANCE,
      'A build carrying a valid provenance record was still reported as having none. A gate that refuses correct '
        + 'builds gets deleted, and then nothing is checked at all.',
    )
    assert.match(output, /provenance -- built from 000000000000/, 'The gate must report which commit the archive came from; a verdict that never names the commit leaves the staleness question unanswered.')
  } finally {
    rmSync(build, { recursive: true, force: true })
  }
})

test('a dirty build is refused unless the variable that authorised building it is set', () => {
  const build = buildWith({ ...CLEAN_RECORD, dirty: true, dirtyFiles: ['app: src/board.css'] })
  try {
    const refused = runGate(build)
    assert.match(
      refused.output,
      /records dirty:true/,
      'An archive whose own record says it cannot be reproduced from git history was shipped without objection.',
    )
    assert.equal(refused.status, 1, 'A dirty artifact must fail by default; the whole point of the recorded flag is that it bites somewhere.')

    const allowed = runGate(build, { MC_ALLOW_DIRTY_BUILD: '1' })
    assert.match(
      allowed.output,
      /SHIPPING A DIRTY BUILD/,
      'The override must broadcast the fact, not silence it -- the failure mode being guarded against is a dirty exe '
        + 'becoming indistinguishable from a clean one a week later.',
    )
    assert.doesNotMatch(allowed.output, /records dirty:true -- these bytes cannot be reproduced/, 'MC_ALLOW_DIRTY_BUILD=1 must actually permit the build it authorised, or it is not an override.')
  } finally {
    rmSync(build, { recursive: true, force: true })
  }
})

test('a present but unreadable or uninformative record is unknown provenance, not clean', () => {
  for (const [label, record] of [
    ['unparseable', '{ this is not json'],
    ['no commit named', { ...CLEAN_RECORD, ref: '' }],
    ['no dirty verdict', { schemaVersion: 2, ref: '0'.repeat(40) }],
  ]) {
    const build = buildWith(record)
    try {
      const { status } = runGate(build)
      assert.equal(
        status,
        1,
        `A provenance record that is ${label} was treated as a passing one. "The record is there but says nothing" `
          + 'and "there is no record" are the same fact about the artifact.',
      )
    } finally {
      rmSync(build, { recursive: true, force: true })
    }
  }
})

/* Driven directly rather than through a subprocess: HEAD is whatever this
   checkout is on, so the comparison cannot be staged end to end without
   committing something. */
test('an archive built from a different commit than the checkout says so out loud', () => {
  const { problems, notes } = judgeProvenance(CLEAN_RECORD, { headRef: 'f'.repeat(40) })
  assert.deepEqual(problems, [], 'A build from an older commit is a legitimate thing to inspect; refusing would stop anyone measuring an installed application at all.')
  assert.ok(
    notes.some((note) => /NOT THE CURRENT CHECKOUT/.test(note)),
    'The gate stayed quiet about an archive built from a different commit than the checkout. That silence is the '
      + 'measured defect: a 90-minute-stale installed build looked exactly like a current one.',
  )
})

test('a matching commit is not reported as stale', () => {
  const { notes } = judgeProvenance(CLEAN_RECORD, { headRef: CLEAN_RECORD.ref })
  assert.ok(!notes.some((note) => /NOT THE CURRENT CHECKOUT/.test(note)), 'A current build must not be labelled stale, or the label stops meaning anything.')
})

/* THE REAL ARTIFACTS ON THIS MACHINE, when they are here. Skipped rather than
   faked when they are not: a build directory that does not exist is not
   evidence of anything, and reporting it as a pass would be the same species of
   lie this whole file is about. */
for (const [label, directory] of [
  ['the release build', path.join(REPO_ROOT, 'release', 'win-unpacked')],
  ['the installed application', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'toolsenabled')],
]) {
  test(`${label} is held to the provenance rule`, { skip: existsSync(path.join(directory, 'resources', 'app.asar')) ? false : `no packaged build at ${directory}` }, () => {
    const { status, output } = runGate(directory)
    assert.notEqual(status, null, 'The gate did not run to completion against a real packaged build.')
    /* Whatever this build turns out to be, the two must agree. A pass while the
       archive carries no record is the defect; a refusal naming a record the
       archive does have is a broken reader. */
    const claimsMissing = NO_PROVENANCE.test(output)
    const reallyMissing = !archiveContains(path.join(directory, 'resources', 'app.asar'), PROVENANCE_ENTRY)
    assert.equal(
      claimsMissing,
      reallyMissing,
      `The gate's verdict about ${PROVENANCE_ENTRY} disagrees with the archive's actual contents in ${directory}.`,
    )
    if (reallyMissing) {
      assert.equal(status, 1, `${directory} carries no provenance record and the gate still did not fail.`)
    }
  })
}

/* An independent reader, so the assertion above is not the gate marking its own
   homework. Deliberately a separate 12-line implementation of the same four
   header words rather than an import of the gate's own walk. */
function archiveContains(archivePath, entryPath) {
  const buffer = readFileSync(archivePath)
  const jsonLength = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
  let node = header
  for (const part of entryPath.split('/')) {
    node = node?.files?.[part]
    if (!node) return false
  }
  return true
}
