import test from 'node:test'
import assert from 'node:assert/strict'
import { terseDetail } from '../gen-projection-lib.mjs'

// The five real preflight strings the designer flagged (websitereport86 /
// designer/page2-restoration-landed): the transform is mechanical and
// content-preserving — every fact survives, nothing shouts, separators
// typeset as the design register expects.
test('terseDetail typesets the real service detail strings', () => {
  assert.equal(terseDetail('owned / healthy'), 'owned · healthy')
  assert.equal(
    terseDetail('conflict / conflict / healthy (listener_identity_mismatch)'),
    'conflict · healthy — listener identity mismatch',
  )
  assert.equal(terseDetail('owned / healthy / operational=true'), 'owned · healthy · operational')
  assert.equal(
    terseDetail('role=receiver, committed key generation=9'),
    'role receiver · committed key generation 9',
  )
  assert.equal(
    terseDetail('11 subsystems, but the observer itself is stale -- this whole snapshot is UNTRUSTWORTHY'),
    '11 subsystems, but the observer itself is stale — this whole snapshot is untrustworthy',
  )
})

test('terseDetail edge behavior', () => {
  assert.equal(terseDetail(null), null)
  assert.equal(terseDetail('   '), null)
  assert.equal(terseDetail('flag=false ok'), 'not flag ok')
  assert.equal(terseDetail('a / a / a'), 'a', 'immediate repeats collapse')
  assert.equal(terseDetail('plain healthy text'), 'plain healthy text', 'plain text passes through')
})
