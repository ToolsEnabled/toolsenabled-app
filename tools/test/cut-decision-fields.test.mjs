// A GATE READS THE FIELD WHERE A DECISION IS RECORDED, NEVER THE FIELD WHERE ONE
// IS EXPLAINED.
//
// Two false greens in one day, in two lanes, from the same mistake: a boundary
// gate that read a file name out of a "$comment" and treated it as a
// classification, and an exempt-tier check that accepted prose as evidence that
// somebody had measured something. Commentary is not data. A decision is a key,
// a list entry, a ref -- something a person had to write ON PURPOSE in the place
// the schema reserves for it.
//
// The audit of this lane's guards found no such read. Every field they consult
// is a decision or a measurement:
//   assertDeclaredEngineSource   declaration.ref
//   assertPackedPayload          PAYLOAD.json sourceRef / fileCount / payloadSha256,
//                                capability-manifest.json helperPrograms
//   assertScratchFence           the three authorities' exported arrays
//   the containment-exempt tier  the KEYS of CONTAINMENT_EXEMPT_REASONS
// The reason STRINGS are never consulted for membership; they are explanation.
//
// That is an absence, and an absence is worth nothing unless something holds it
// open. These are the synthetic cases that do: each hands a guard a file whose
// COMMENTARY says the right thing and whose DECISION FIELD does not, and
// requires the guard to read it as undecided.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  assertDeclaredEngineSource,
  assertPackedPayload,
} from '../release-packager/cut-release-candidate.mjs'
import { CONTAINMENT_EXEMPT_REASONS } from '../lib/scratch-fence.mjs'

const ENGINE = 'bafd25a5b72466a8ed33f44e1419981a438fedd4'
const PAYLOAD = path.join('C:', 'build', 'capability')

test('an engine ref named only in a $comment is not a declaration', () => {
  // The exact shape of the real file, with the ref moved into the prose.
  const commentaryOnly = {
    $comment: `Exact reviewed engine input for this cut: ${ENGINE}. Builder-local, ignored, never published.`,
    path: path.join('C:', 'engine'),
  }
  assert.throws(
    () => assertDeclaredEngineSource(commentaryOnly, ENGINE),
    /declares no engine ref/,
    'a ref that appears only in prose leaves the declaration undecided',
  )

  // And the mirror: prose that names the WRONG ref must not rescue a right one,
  // nor the reverse. Only the field decides.
  const decidedButContradicted = {
    $comment: 'this engine input is e2d443c5be89f5e851f4b4b5d9262c8fa6aeb011, honestly',
    path: path.join('C:', 'engine'),
    ref: ENGINE,
  }
  assert.equal(assertDeclaredEngineSource(decidedButContradicted, ENGINE), ENGINE,
    'the field decides, and prose disagreeing with it changes nothing')
})

test('a helper named only in a manifest comment is not declared', () => {
  // tools/capability-manifest.json really does carry a $comment_helperPrograms
  // explaining why helpers must be declared. A gate that scanned the file for
  // the string would find the helper there and call it declared.
  const manifestPath = path.join('C:', 'repo', 'tools', 'capability-manifest.json')
  const commentaryManifest = JSON.stringify({
    $comment_helperPrograms: 'programs such as tools/secrets-manager.ps1 must be declared, because the require() walk cannot see them',
    helperPrograms: ['tools/secrets.ps1'],
  })
  const read = (file) => (file === manifestPath ? commentaryManifest : JSON.stringify({
    sourceRef: ENGINE, fileCount: 1, payloadSha256: 'a'.repeat(64),
  }))
  // The payload does NOT contain secrets-manager.ps1. If the gate read the
  // comment as a declaration it would demand the file and fail; if it reads
  // helperPrograms it demands only secrets.ps1 and passes. Passing here is the
  // proof that the comment was not treated as data.
  const exists = (file) => file === manifestPath
    || file === path.join(PAYLOAD, 'PAYLOAD.json')
    || file === path.join(PAYLOAD, 'tools', 'secrets.ps1')
  const measured = assertPackedPayload(PAYLOAD, ENGINE, manifestPath, {
    read, exists, measureTree: () => ({ fileCount: 1, byteCount: 1, payloadSha256: 'a'.repeat(64) }),
  })
  assert.equal(measured.helpers, 1,
    'only the declared list counts; the comment naming a second helper is prose')

  // And when the helper IS declared, its absence is caught -- so the case above
  // is the gate reading the right field, not the gate being blind.
  const decidedManifest = JSON.stringify({
    $comment_helperPrograms: 'unchanged prose',
    helperPrograms: ['tools/secrets.ps1', 'tools/secrets-manager.ps1'],
  })
  assert.throws(
    () => assertPackedPayload(PAYLOAD, ENGINE, manifestPath, {
      read: (file) => (file === manifestPath ? decidedManifest : read(file)),
      exists,
      measureTree: () => ({ fileCount: 1, byteCount: 1, payloadSha256: 'a'.repeat(64) }),
    }),
    /tools\/secrets-manager\.ps1/,
    'a declared helper missing from the payload is still refused',
  )
})

test('the containment-exempt tier is decided by its keys, not by its reasons', () => {
  // The reason strings are explanation. Membership is the KEY. A name with a
  // reason written about it but no key of its own is not in the tier, and this
  // is what stops "somebody wrote a paragraph" from becoming "somebody decided".
  const reasons = CONTAINMENT_EXEMPT_REASONS
  const mentionedInProse = Object.values(reasons).join(' ')
  assert.match(mentionedInProse, /TOOLSENABLED_VAULT_PATH|registry-write/,
    'the reasons do mention other names and files, which is exactly the hazard')
  for (const name of ['TOOLSENABLED_VAULT_PATH', 'TOOLSENABLED_STATE_ROOT', 'APPDATA']) {
    assert.ok(!Object.hasOwn(reasons, name),
      `${name} must not be exempt; being named inside another name's reason is not a decision`)
  }
})
