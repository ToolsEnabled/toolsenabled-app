// WHAT THE CUT PACKS, AND WHETHER ANY GATE ACTUALLY READ IT.
//
// Measured on the b4a assembly worktree, 2026-09-17, at app d8ea7ae7:
//   private/capability-source.owner.json  ref       e2d443c5be89f5e851f4b4b5d9262c8fa6aeb011
//   capability/PAYLOAD.json               sourceRef e2d443c5be89f5e851f4b4b5d9262c8fa6aeb011
//   capability/tools/secrets-manager.ps1            ABSENT
// while the cut was told --engine-source-ref bafd25a5b..., 36 commits ahead,
// and tools/capability-manifest.json at that tip declares secrets-manager.ps1.
//
// Nobody repacked it wrongly. pack-capability-layer.mjs resolves its engine
// checkout from the WORKTREE'S OWN private declaration and refuses a
// --source-ref that disagrees, so a build worktree ships whatever its private
// file pinned when it was created. The cut passed a flag and never compared it
// to that file, so the disagreement was silent.
//
// The second half is the gate that would not have caught it either:
// tools/test/vault-manager-staged.test.mjs reads MC_TEST_CAPABILITY_PAYLOAD and
// calls t.skip() naming itself when that is unset. Neither the cutter nor
// tools/test-ratchet.mjs ever set it. A skip is not a pass, but a strict
// acceptance run counts it as one, so the cut would have sealed green over the
// exact missing helper that makes system.credential_remove fail closed on the
// installed product.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import {
  PAYLOAD_GATE_VARIABLES,
  assertDeclaredEngineSource,
  assertPackedPayload,
  assertPayloadGatesBound,
  buildDistChainEnvironment,
  measurePackedTree,
} from '../release-packager/cut-release-candidate.mjs'

const ENGINE = 'bafd25a5b72466a8ed33f44e1419981a438fedd4'
const STALE = 'e2d443c5be89f5e851f4b4b5d9262c8fa6aeb011'
const PAYLOAD = path.join('C:', 'build', 'capability')

/* The manifest is given to assertPackedPayload as a PATH and read there, so a
 * caller cannot shorten the declared list and thereby shorten the check. */
const manifestDir = mkdtempSync(path.join(os.tmpdir(), 'w86-manifest-'))
const manifest = path.join(manifestDir, 'capability-manifest.json')
writeFileSync(manifest, JSON.stringify({ helperPrograms: ['tools/secrets.ps1', 'tools/secrets-manager.ps1'] }))
process.on('exit', () => rmSync(manifestDir, { recursive: true, force: true }))
// A payload that carries everything the manifest declares.
const complete = (relative) => relative === manifest
  || relative === path.join(PAYLOAD, 'PAYLOAD.json')
  || relative === path.join(PAYLOAD, 'tools', 'secrets.ps1')
  || relative === path.join(PAYLOAD, 'tools', 'secrets-manager.ps1')
// Path-aware, because assertPackedPayload reads two different files: the
// manifest it was given the path of, and the payload's own PAYLOAD.json.
const TREE = { fileCount: 3, byteCount: 10, payloadSha256: 'a'.repeat(64) }
const readPacked = (ref) => (file) => (file === manifest
  ? JSON.stringify({ helperPrograms: ['tools/secrets.ps1', 'tools/secrets-manager.ps1'] })
  : JSON.stringify({ sourceRef: ref, ...TREE }))
// The tree measurement is injected in these cases; the recompute itself has its
// own test below and against the real 1169-file payload.
const measuresTree = () => ({ ...TREE })

test('a build worktree declaring a different engine than --engine-source-ref is refused before packing', () => {
  assert.equal(assertDeclaredEngineSource({ ref: ENGINE }, ENGINE), ENGINE, 'agreement passes through')
  assert.equal(assertDeclaredEngineSource({ ref: ENGINE.toUpperCase() }, ENGINE), ENGINE, 'case is not a disagreement')

  // The measured b4a case.
  assert.throws(
    () => assertDeclaredEngineSource({ ref: STALE }, ENGINE),
    (error) => {
      assert.match(error.message, new RegExp(STALE), 'names what the worktree declared')
      assert.match(error.message, new RegExp(ENGINE), 'names what the cut was told')
      assert.match(error.message, /follows the FILE, not the flag/, 'says why the flag alone did not decide')
      return true
    },
  )

  assert.throws(() => assertDeclaredEngineSource(null, ENGINE), /declares no engine ref/,
    'a worktree with no declaration at all is refused, not defaulted')
  assert.throws(() => assertDeclaredEngineSource({}, ENGINE), /declares no engine ref/)
})

test('the packed payload itself is measured, not trusted from the declaration', () => {
  const measured = assertPackedPayload(PAYLOAD, ENGINE, manifest, { read: readPacked(ENGINE), exists: complete, measureTree: measuresTree })
  assert.equal(measured.sourceRef, ENGINE)
  assert.equal(measured.helpers, 2)

  // MUTATION 1: the packer produced a payload from the stale ref anyway.
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifest, { read: readPacked(STALE), exists: complete, measureTree: measuresTree }),
    (error) => {
      assert.match(error.message, new RegExp(`PAYLOAD.json sourceRef: ${STALE}`), 'names what was staged')
      assert.match(error.message, new RegExp(ENGINE), 'names what was declared')
      return true
    },
  )

  // MUTATION 2: the exact b4a shape -- right ref, declared helper missing.
  const withoutManager = (p) => complete(p) && p !== path.join(PAYLOAD, 'tools', 'secrets-manager.ps1')
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifest, { read: readPacked(ENGINE), exists: withoutManager, measureTree: measuresTree }),
    (error) => {
      assert.match(error.message, /tools\/secrets-manager\.ps1/, 'names the helper that is missing')
      assert.match(error.message, /fails closed on the installed product/, 'says what its absence costs a person')
      return true
    },
  )

  // The manifest is present; the PAYLOAD is not. That is the "nothing was
  // packed here" case, and it must be refused rather than read as empty.
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifest, { read: readPacked(ENGINE), exists: (file) => file === manifest, measureTree: measuresTree }),
    /no PAYLOAD.json/,
    'an unpacked payload is refused rather than read as empty',
  )

  // And the mirror: a payload with no manifest to check it against is refused
  // too, rather than passing with an empty declared list.
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifest, { read: readPacked(ENGINE), exists: (file) => file !== manifest, measureTree: measuresTree }),
    /capability manifest does not exist/,
    'no manifest means no declared helper list, which is not the same as nothing declared',
  )
})

test('the cut refuses to run the acceptance ratchet with any payload gate unbound', () => {
  const bound = Object.fromEntries(PAYLOAD_GATE_VARIABLES.map((name) => [name, PAYLOAD]))
  assert.equal(assertPayloadGatesBound(bound, PAYLOAD), PAYLOAD, 'all five bound to this cut\'s payload passes')

  // MUTATION 3: the wiring is removed -- every variable unset, which is exactly
  // what the cutter did before this change.
  assert.throws(
    () => assertPayloadGatesBound({}, PAYLOAD),
    (error) => {
      for (const name of PAYLOAD_GATE_VARIABLES) {
        assert.match(error.message, new RegExp(name), `names ${name} as unbound`)
      }
      assert.match(error.message, /named skip, not a failure/, 'says why a skip is the danger')
      return true
    },
  )

  // MUTATION 4: only the one with no fallback is dropped. The other four would
  // still read <repo>/capability by accident, which is what hid this.
  const { MC_TEST_CAPABILITY_PAYLOAD, ...missingOne } = bound
  assert.throws(() => assertPayloadGatesBound(missingOne, PAYLOAD), /MC_TEST_CAPABILITY_PAYLOAD/,
    'the variable with no default is the one that silently skips, so it must be named')

  // MUTATION 5: bound, but at some other payload on this box.
  assert.throws(
    () => assertPayloadGatesBound({ ...bound, MC_TEST_AUDIT_PAYLOAD: path.join('C:', 'elsewhere', 'capability') }, PAYLOAD),
    /does not name this cut's packed payload|do\(es\) not name this cut's packed payload/,
    'a gate reading another payload proves nothing about this candidate',
  )
})

test('buildDistChainEnvironment binds all five payload gates to the packed payload', () => {
  const env = buildDistChainEnvironment({}, { workspaceSegments: ['fixture-workspace'],
    scratchState: path.join('C:', 's'),
    scratchTemp: path.join('C:', 't'),
    payloadRoot: PAYLOAD,
    platform: 'win32',
  })
  for (const name of PAYLOAD_GATE_VARIABLES) {
    assert.equal(env[name], PAYLOAD, `${name} must name the packed payload`)
  }
  assert.equal(assertPayloadGatesBound(env, PAYLOAD), PAYLOAD,
    'the environment the cut actually builds satisfies its own refusal')
})

// THE RECORD MUST DESCRIBE THE TREE THAT IS ACTUALLY THERE.
//
// pack-capability-layer.mjs already wrote fileCount, byteCount and
// payloadSha256 into PAYLOAD.json; until now nothing read them back, so a
// payload that lost a file after packing -- or gained one nobody declared --
// still presented a record that agreed with itself. Validated against the real
// 1169-file payload: recorded and recomputed agree exactly, and removing one
// helper moves both numbers.
test('the packed tree is recomputed and compared against its own record', () => {
  const RECORDED = { sourceRef: ENGINE, fileCount: 3, payloadSha256: 'a'.repeat(64) }
  const readRecorded = (file) => (file === manifest
    ? JSON.stringify({ helperPrograms: ['tools/secrets.ps1', 'tools/secrets-manager.ps1'] })
    : JSON.stringify(RECORDED))

  const agreeing = () => ({ fileCount: 3, byteCount: 10, payloadSha256: 'a'.repeat(64) })
  assert.doesNotThrow(() => assertPackedPayload(PAYLOAD, ENGINE, manifest,
    { read: readRecorded, exists: complete, measureTree: agreeing }))

  // MUTATION: a file went missing after the record was written.
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifest,
      { read: readRecorded, exists: complete, measureTree: () => ({ fileCount: 2, byteCount: 8, payloadSha256: 'b'.repeat(64) }) }),
    (error) => {
      assert.match(error.message, /fileCount: PAYLOAD\.json records 3, the staged tree has 2/, 'names both counts')
      assert.match(error.message, /payloadSha256: PAYLOAD\.json records a{64}, the staged tree hashes to b{64}/, 'names both digests')
      return true
    },
  )

  // MUTATION: same count, different bytes -- an undeclared file swapped in for
  // a declared one would not move the count, so the digest has to carry it.
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifest,
      { read: readRecorded, exists: complete, measureTree: () => ({ fileCount: 3, byteCount: 10, payloadSha256: 'c'.repeat(64) }) }),
    /payloadSha256/,
    'a count that still matches does not excuse a tree that hashes differently',
  )
})

test('measurePackedTree follows the packer construction: sorted, NUL-separated, PAYLOAD.json excluded', () => {
  const files = { 'b.txt': Buffer.from('two'), 'a.txt': Buffer.from('one'), 'PAYLOAD.json': Buffer.from('{}') }
  const walk = (dir, _options) => (path.relative(PAYLOAD, dir) === ''
    ? Object.keys(files).map((name) => ({ name, isDirectory: () => false }))
    : [])
  const readBytes = (file) => files[path.basename(file)]
  const measured = measurePackedTree(PAYLOAD, { walk, readBytes })
  assert.equal(measured.fileCount, 2, 'PAYLOAD.json is excluded, because the packer hashes before writing it')
  assert.equal(measured.byteCount, 6)

  const expected = createHash('sha256')
  for (const relative of ['a.txt', 'b.txt']) { // sorted
    expected.update(relative); expected.update('\0'); expected.update(files[relative])
  }
  assert.equal(measured.payloadSha256, expected.digest('hex'),
    'the same construction pack-capability-layer.mjs uses, so a disagreement is a real difference')
})
