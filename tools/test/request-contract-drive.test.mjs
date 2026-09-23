import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { filesCarrying, SCAN_INDETERMINATE } from '../request-contract-drive.mjs'

test('an indeterminate contract rollout scan is not absence and is not latched', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'request-contract-scan-'))
  try {
    const carrier = path.join(scratch, 'rollout.jsonl')
    writeFileSync(carrier, 'needle', 'utf8')
    let calls = 0
    const readDirectory = (...args) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' })
      return Reflect.apply(readdirSync, null, args)
    }

    assert.throws(
      () => filesCarrying(scratch, 'needle', { readDirectory }),
      error => error?.code === SCAN_INDETERMINATE && /does NOT claim.*absent/.test(error.message),
    )

    // The real operation succeeds after the failure: a cached empty answer, or
    // any latch that skipped the retry, would make this control fail.
    assert.deepEqual(filesCarrying(scratch, 'needle', { readDirectory }), [carrier])
    assert.deepEqual(filesCarrying(path.join(scratch, 'legitimately-absent'), 'needle'), [])
    assert.equal(calls, 2)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
