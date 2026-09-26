import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readJsonIfPresent } from '../test-account-harness.mjs'

test('readJsonIfPresent distinguishes absence from a read it could not make', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'account-harness-json-'))
  try {
    const absent = path.join(scratch, 'absent.json')
    assert.equal(readJsonIfPresent(absent), null, 'ENOENT remains the legitimate absent answer')

    const unreadableAsJson = path.join(scratch, 'directory.json')
    mkdirSync(unreadableAsJson)
    const first = readJsonIfPresent(unreadableAsJson)
    assert.deepEqual(first, {
      code: 'JSON_READ_COULD_NOT_TELL',
      reason: `Could not read ${unreadableAsJson}; this is not claiming the file is absent.`,
      errorCode: 'EISDIR',
    })

    /* CONTROL: neither the successful value nor a failure is cached. Replacing
       the directory with a real file must be observed by the very next call. */
    rmSync(unreadableAsJson, { recursive: true })
    writeFileSync(unreadableAsJson, '{"ready":true}\n')
    assert.deepEqual(readJsonIfPresent(unreadableAsJson), { ready: true })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
