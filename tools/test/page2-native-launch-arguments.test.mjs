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

test('an explicit provider home selects a real-provider request in place', () => {
  for (const flag of ['--codex-profile-home', '--codex-home']) {
    const options = optionsFrom(['--real-provider', flag, '/owned/selected'])
    assert.equal(options.codexProfileHome, '/owned/selected')
    assert.equal(options.level, 'standard')
    assert.deepEqual(electronLaunchArguments('/runtime', '/qa', options), ['/runtime', '--user-data-dir=/qa'])
    assert.throws(() => optionsFrom([flag, '/owned/selected']), /requires --real-provider/)
  }
  assert.throws(() => optionsFrom(['--real-provider', '--codex-account-id-sha256', 'a'.repeat(64)]), /Unknown/)
  assert.throws(() => optionsFrom(['--real-provider', '--retain-provider-credentials']), /Unknown/)
})

test('native QA can retain socket scratch below an explicit private account parent', () => {
  const options = optionsFrom(['--out', '/\x68ome/qa/private/runs', '--socket-temp-parent', '/\x68ome/qa/private/tmp', '--retain-socket-temp'])
  assert.equal(options.out, '/\x68ome/qa/private/runs')
  assert.equal(options.retainSocketTemp, true)
  assert.equal(linuxSocketTemporaryPrefix(options, '/\x68ome/qa'), '/\x68ome/qa/private/tmp/te-page2-')
  assert.equal(linuxSocketTemporaryPrefix({}, '/\x68ome/qa'), '/\x68ome/qa/.cache/te-page2-')
  assert.throws(() => optionsFrom(['--retain-socket-temp', '--retain-socket-temp']), /Duplicate/)
  assert.throws(() => optionsFrom(['--socket-temp-parent']), /needs a value/)
})

test('native socket scratch refuses aliases, foreign homes and overlong Unix socket paths before filesystem access', () => {
  for (const socketTempParent of ['relative', '/tmp', '/\x68ome/other/private', '/\x68ome/qa/../other', '/\x68ome/qa', '/\x68ome/qa/private/\0bad']) {
    assert.throws(() => linuxSocketTemporaryPrefix({ socketTempParent }, '/\x68ome/qa'), /absolute path|owning account/)
  }
  assert.throws(() => linuxSocketTemporaryPrefix({ socketTempParent: '/\x68ome/qa/' + 'x'.repeat(70) }, '/\x68ome/qa'), /too long/)
})
