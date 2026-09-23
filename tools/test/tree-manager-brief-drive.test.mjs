import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeStoredJson } from '../tree-manager-brief-drive.mjs'

test('stored-state corruption is indeterminate, not absent, and is not latched', () => {
  // CONTROL: localStorage.getItem's genuine absence answer remains unchanged.
  assert.equal(decodeStoredJson(null, 'the fleet tree'), null)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => decodeStoredJson('{', 'the fleet tree'),
      error => {
        assert.equal(error.code, 'STORAGE_VALUE_INDETERMINATE')
        assert.match(error.message, /NOT claiming absence/)
        return true
      },
    )
  }

  // A failed read was not cached/latched: the next value is parsed normally.
  assert.deepEqual(decodeStoredJson('{"nodes":[]}', 'the fleet tree'), { nodes: [] })
})
