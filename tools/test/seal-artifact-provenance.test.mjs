/* T392/T394: A PUBLISHED ARTIFACT CARRIES THE COMMIT IT WAS BUILT FROM, AND IS
 * BOUND TO THE TIP IT IS PUBLISHED AS.
 *
 * Run: node --test tools/test/seal-artifact-provenance.test.mjs
 *
 * MEASURED on the 1.0.45 publish: the seal beside the published installer
 * carried no builtSha and no recordedHead -- the older seal format records
 * per-file hashes and nothing about provenance -- and --verify passed over it,
 * because the built-vs-artifact comparison was guarded on `parsed.builtSha &&`.
 * An unbound artifact therefore read as a verified one.
 *
 * The second half is the one a sound seal still does not answer: WHICH tip was
 * published. The bytes can be internally consistent and belong to a commit
 * nobody meant to ship. --expect-ref is that comparison, at record and at
 * verify.
 *
 * Fixtures are synthetic artifacts stating their own provenance under
 * resources/app/dist/.dist-source.json, with MC_SEAL_SOURCE_HEAD supplying the
 * source head, the same rig tools/test/seal-artifact.test.mjs uses.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'seal-artifact.mjs')
const BUILT_SHA = ''.padEnd(40, 'a')
const OTHER_SHA = ''.padEnd(40, 'b')

function run(args, head = BUILT_SHA) {
  const result = spawnSync(process.execPath, [TOOL, ...args],
    { encoding: 'utf8', env: { ...process.env, MC_SEAL_SOURCE_HEAD: head, MC_SEAL_SOURCE_CLEAN: '1' } })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/* A built artifact that states its own provenance, plus the path of the seal
   that will be written beside it. */
function artifact(name, appHead = BUILT_SHA) {
  const root = mkdtempSync(path.join(os.tmpdir(), `seal-provenance-${name}-`))
  const built = path.join(root, 'win-unpacked')
  mkdirSync(path.join(built, 'resources', 'app', 'dist'), { recursive: true })
  writeFileSync(path.join(built, 'application.bin'), 'built artifact\n')
  writeFileSync(path.join(built, 'resources', 'app', 'dist', '.dist-source.json'),
    `${JSON.stringify({ schemaVersion: 1, appHead })}\n`)
  return { root, built, seal: path.join(root, '.artifact-seal-win-unpacked.json') }
}

test('a seal that records no built commit is refused, not verified', () => {
  const { root, built, seal } = artifact('unbound')
  try {
    assert.equal(run(['--record', built]).status, 0)

    /* Exactly the shape found beside the published installer: real file hashes,
       no provenance at all. */
    const parsed = JSON.parse(readFileSync(seal, 'utf8'))
    delete parsed.builtSha
    delete parsed.recordedHead
    writeFileSync(seal, `${JSON.stringify(parsed, null, 2)}\n`)

    const result = run(['--verify', built])
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /ARTIFACT_SEAL_NO_BUILT_SHA/)
    assert.match(result.output, /UNBOUND rather than verified/)
    /* And it must not read as a clean verify on the way past. */
    assert.doesNotMatch(result.output, /byte-identical to the seal/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an artifact that no longer states its provenance fails against a bound seal', () => {
  const { root, built, seal } = artifact('marker-removed')
  try {
    assert.equal(run(['--record', built]).status, 0)
    rmSync(path.join(built, 'resources', 'app', 'dist', '.dist-source.json'))

    const result = run(['--verify', built])
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /ARTIFACT_SEAL_BINARY_MISMATCH/)
    assert.ok(readFileSync(seal, 'utf8').includes(BUILT_SHA), 'the seal still names the commit it bound')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--expect-ref binds the seal to the tip being published, at record and at verify', () => {
  const { root, built } = artifact('expect-ref')
  try {
    /* The tip the cut says it is publishing is the tip the binary carries. */
    const recorded = run(['--record', built, '--expect-ref', BUILT_SHA])
    assert.equal(recorded.status, 0, recorded.output)
    const verified = run(['--verify', built, '--expect-ref', BUILT_SHA])
    assert.equal(verified.status, 0, verified.output)
    assert.match(verified.output, /the tip being published/)

    /* Sound bytes, sound seal, wrong tip. */
    const wrongTip = run(['--verify', built, '--expect-ref', OTHER_SHA])
    assert.equal(wrongTip.status, 1, wrongTip.output)
    assert.match(wrongTip.output, /ARTIFACT_SEAL_NOT_THE_EXPECTED_REF/)
    assert.match(wrongTip.output, /not the bytes that tip names/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a record whose binary carries a different commit than the tip being published is refused', () => {
  /* The binary states one commit; the cut names another. Sealing it would bind
     an artifact to a tip it does not carry, which is how a build ships under a
     ref that never produced it. */
  const { root, built } = artifact('record-wrong-tip')
  try {
    const result = run(['--record', built, '--expect-ref', OTHER_SHA])
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /ARTIFACT_SEAL_NOT_THE_EXPECTED_REF/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('without --expect-ref a bound seal still records and verifies, so this is not refuse-everything', () => {
  const { root, built } = artifact('control')
  try {
    assert.equal(run(['--record', built]).status, 0)
    const verified = run(['--verify', built])
    assert.equal(verified.status, 0, verified.output)
    assert.match(verified.output, new RegExp(`the sealed binary was built from ${BUILT_SHA}`))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
