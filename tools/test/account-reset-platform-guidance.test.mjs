import test from 'node:test'
import assert from 'node:assert/strict'

import {
  outcomeLines,
  readSweep,
  RESET_SUBJECT_HERE,
  RESET_SUBJECT_REMOTE,
  survivesLines,
} from '../../src/account-reset-copy.js'

const COMPLETE_REPLY = {
  ok: true,
  swept: {
    ok: true,
    complete: true,
    remainingFiles: 0,
    remainingBytes: 0,
    results: [],
  },
  revoked: { ok: true, revokedSessions: true },
}

function survivorDetail(subject, platform) {
  return survivesLines({ subject, platform })[0].detail
}

test('own-target survivor guidance uses Windows Settings only for a win32 target', () => {
  const cases = [
    ['win32', true],
    ['linux', false],
    ['darwin', false],
    ['unknown', false],
  ]

  for (const [platform, windows] of cases) {
    const detail = survivorDetail(RESET_SUBJECT_HERE, platform)
    assert.equal(
      detail.includes('Windows Settings'),
      windows,
      platform + ' guidance must ' + (windows ? '' : 'not ') + 'name Windows Settings',
    )
    assert.match(detail, /This empties the data\. It does not uninstall ToolsEnabled\./)
    if (!windows) assert.match(detail, /the way you installed it/)
  }
})

test('remote-target survivor guidance uses explicit target platform and never a driver fallback', () => {
  const neutral = survivorDetail(RESET_SUBJECT_REMOTE, undefined)
  assert.doesNotMatch(neutral, /Windows Settings/)
  assert.match(neutral, /the computer you are driving/)
  assert.match(neutral, /the way you installed it/)

  const remoteWindows = survivorDetail(RESET_SUBJECT_REMOTE, 'win32')
  assert.match(remoteWindows, /Windows Settings → Apps → Installed apps/)
  assert.match(remoteWindows, /the computer you are driving/)

  const remoteLinux = survivorDetail(RESET_SUBJECT_REMOTE, 'linux')
  assert.doesNotMatch(remoteLinux, /Windows Settings/)
  assert.match(remoteLinux, /the way you installed it/)
})

test('omitted and unknown target platforms stay neutral instead of silently selecting Windows', () => {
  for (const subject of [RESET_SUBJECT_HERE, RESET_SUBJECT_REMOTE]) {
    const omitted = survivesLines({ subject })[0].detail
    const unknown = survivesLines({ subject, platform: 'unknown' })[0].detail
    assert.doesNotMatch(omitted, /Windows Settings/)
    assert.doesNotMatch(unknown, /Windows Settings/)
    assert.match(omitted, /does not uninstall ToolsEnabled/)
    assert.match(unknown, /does not uninstall ToolsEnabled/)
  }
})

test('complete outcome guidance follows the target platform without weakening deletion proof', () => {
  const sweep = readSweep(COMPLETE_REPLY)

  for (const subject of [RESET_SUBJECT_HERE, RESET_SUBJECT_REMOTE]) {
    for (const [platform, windows] of [['win32', true], ['linux', false], ['darwin', false], ['unknown', false]]) {
      const outcome = outcomeLines(sweep, { subject, platform })
      assert.equal(outcome.tone, 'good')
      assert.equal(outcome.title, 'It is gone.')
      assert.match(outcome.detail, /Every file this program had saved .* was removed, checked one by one after deleting/)
      assert.match(outcome.detail, /still installed/)
      assert.equal(
        outcome.detail.includes('Windows Settings'),
        windows,
        subject + '/' + platform + ' must ' + (windows ? '' : 'not ') + 'name Windows Settings',
      )
      if (!windows) assert.match(outcome.detail, /the way you installed it/)
    }
  }

  const omitted = outcomeLines(sweep)
  assert.doesNotMatch(omitted.detail, /Windows Settings/)
  assert.match(omitted.detail, /the way you installed it/)
})
