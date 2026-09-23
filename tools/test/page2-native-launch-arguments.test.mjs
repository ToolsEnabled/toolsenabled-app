import assert from 'node:assert/strict'
import { test } from 'node:test'
import { optionsFrom, electronLaunchArguments, linuxSocketTemporaryPrefix } from '../page2-native-audit.cjs'

test('native dialog backend defaults to the desktop and never changes sandbox arguments', () => {
  const options = optionsFrom([])
  assert.equal(options.linuxDialogBackend, 'desktop')
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(electronLaunchArguments('/runtime', '/profile', options, platform), ['/runtime', '--user-data-dir=/profile'])
  }
})

test('an explicit native GTK backend uses the documented portal-version fallback only on Linux', () => {
  const options = optionsFrom(['--linux-dialog-backend', 'gtk'])
  assert.deepEqual(electronLaunchArguments('/runtime', '/profile', options, 'linux'), ['/runtime', '--user-data-dir=/profile', '--xdg-portal-required-version=2147483647'])
  assert.throws(() => electronLaunchArguments('/runtime', '/profile', options, 'win32'), /only on Linux/)
  assert.throws(() => optionsFrom(['--linux-dialog-backend', 'mock']), /desktop or gtk/)
})

test('an explicit provider source and expected account fingerprint travel only as a complete real-provider request', () => {
  const fingerprint = 'a'.repeat(64)
  const options = optionsFrom(['--real-provider', '--codex-profile-home', '/owned/selected', '--codex-account-id-sha256', fingerprint])
  assert.equal(options.codexProfileHome, '/owned/selected')
  assert.equal(options.codexAccountIdSha256, fingerprint)
  assert.equal(options.level, 'standard')
  assert.deepEqual(electronLaunchArguments('/runtime', '/qa', options), ['/runtime', '--user-data-dir=/qa'])
  for (const args of [
    ['--real-provider', '--codex-profile-home', '/owned/selected'],
    ['--real-provider', '--codex-account-id-sha256', fingerprint],
    ['--codex-profile-home', '/owned/selected', '--codex-account-id-sha256', fingerprint],
    ['--real-provider', '--codex-profile-home', '/owned/selected', '--codex-account-id-sha256', 'short'],
  ]) assert.throws(() => optionsFrom(args), /requires .* together/)
})


test('native QA can retain socket scratch below an explicit private account parent', () => {
  const options = optionsFrom(['--out', '/home/qa/private/runs', '--socket-temp-parent', '/home/qa/private/tmp', '--retain-socket-temp'])
  assert.equal(options.out, '/home/qa/private/runs')
  assert.equal(options.retainSocketTemp, true)
  assert.equal(linuxSocketTemporaryPrefix(options, '/home/qa'), '/home/qa/private/tmp/te-page2-')
  assert.equal(linuxSocketTemporaryPrefix({}, '/home/qa'), '/home/qa/.cache/te-page2-')
  assert.throws(() => optionsFrom(['--retain-socket-temp', '--retain-socket-temp']), /Duplicate/)
  assert.throws(() => optionsFrom(['--socket-temp-parent']), /needs a value/)
})

test('native socket scratch refuses aliases, foreign homes and overlong Unix socket paths before filesystem access', () => {
  for (const socketTempParent of ['relative', '/tmp', '/home/other/private', '/home/qa/../other', '/home/qa', '/home/qa/private/\0bad']) {
    assert.throws(() => linuxSocketTemporaryPrefix({ socketTempParent }, '/home/qa'), /absolute path|owning account/)
  }
  assert.throws(() => linuxSocketTemporaryPrefix({ socketTempParent: '/home/qa/' + 'x'.repeat(70) }, '/home/qa'), /too long/)
})
