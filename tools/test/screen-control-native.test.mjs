import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')

// Linux always creates a private X11 server: neither an inherited DISPLAY nor
// an opt-in may direct this test's native input onto the owner's desktop.
// Windows still requires an explicitly allocated interactive proof desktop.
test('actual desktop input and capture', { skip: process.platform !== 'linux' && process.env.MC_SCREEN_CONTROL_NATIVE_TEST !== '1', timeout: 30000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'screen-control-native-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
  env.XDG_SESSION_TYPE = process.platform === 'linux' ? 'x11' : env.XDG_SESSION_TYPE
  delete env.WAYLAND_DISPLAY
  const electronArgs = [path.join(root, 'tools/test/helpers/screen-control-electron.cjs'), dataRoot]
  const executable = process.platform === 'linux' ? '/usr/bin/xvfb-run' : require('electron')
  const args = process.platform === 'linux'
    ? ['-a', '-s', '-screen 0 1440x1000x24 -nolisten tcp', require('electron'), ...electronArgs]
    : electronArgs
  const { stdout } = await promisify(execFile)(executable, args, {
    cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024,
  })
  const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.ok)
  assert.ok(result, 'native input must produce the expected application state and screenshot')
})
