import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { pathHasCodex, recordedTier } from '../four-defects-drive.mjs'

const profileFixture = () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'recorded-tier-'))
  /* openWindow() launches --user-data-dir=<profile>/userdata, and that exact
     product-directory basename owns the machine record in the sterile rig. */
  const record = path.join(profile, 'local', 'userdata', 'machine.json')
  mkdirSync(path.dirname(record), { recursive: true })
  return { profile, record }
}

test('only ENOENT means that the machine record is absent', t => {
  const { profile, record } = profileFixture()
  t.after(() => rmSync(profile, { recursive: true, force: true }))

  assert.equal(recordedTier(profile), null, 'a genuinely absent record keeps its established answer')
  writeFileSync(record, JSON.stringify({ tier: 'guided' }))
  assert.equal(recordedTier(profile), 'guided', 'a readable record still reports its tier')
})

test('a failed read is an explicit could-not-tell answer and is not cached', t => {
  const { profile } = profileFixture()
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  let reads = 0
  const busy = Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' })
  const readFile = () => {
    reads += 1
    if (reads === 1) throw busy
    return JSON.stringify({ tier: 'unrestricted' })
  }

  assert.throws(
    () => recordedTier(profile, { readFile }),
    error => error.code === 'MACHINE_RECORD_TIER_COULD_NOT_BE_READ'
      && /not claiming.*absent/i.test(error.message)
      && error.cause === busy,
  )
  assert.equal(recordedTier(profile, { readFile }), 'unrestricted',
    'the transient failure was not cached or latched')
  assert.equal(reads, 2, 'the second call paid for and performed a fresh read')
})

test('PATH filtering distinguishes a missing command from a probe failure', () => {
  const absent = Object.assign(new Error('missing'), { code: 'ENOENT' })
  assert.equal(pathHasCodex('/missing', { access: () => { throw absent } }), false,
    'ENOENT remains the one definite absent answer')

  let checks = 0
  const busy = Object.assign(new Error('filesystem busy'), { code: 'EAGAIN' })
  const access = () => {
    checks += 1
    if (checks === 1) throw busy
  }
  assert.throws(
    () => pathHasCodex('/busy', { access }),
    error => error.code === 'CODEX_PATH_PRESENCE_COULD_NOT_BE_READ'
      && /not claiming.*absent/i.test(error.message)
      && error.cause === busy,
  )
  assert.equal(pathHasCodex('/busy', { access }), true, 'the failed probe is not cached or latched')
  assert.equal(checks, 2, 'a fresh filesystem probe is performed after the transient failure')
})
