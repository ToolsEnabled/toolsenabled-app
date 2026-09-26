import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'

const { acknowledgeGnomeTerminal, MAX_DIAGNOSTIC_BYTES } = createRequire(import.meta.url)(
  '../../shell/gnome-terminal-acknowledgement.cjs',
)
const options = { stdio: ['ignore', 'ignore', 'pipe'], shell: false,
  env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }
// Real child streams and process outcomes, with private Node children emitting
// controlled launcher diagnostics. Native GNOME/main/preload proof is separate.
const fixture = (diagnostic, code = 0) => spawn(process.execPath, ['-e',
  'process.stderr.write(process.argv[1]); process.exitCode = Number(process.argv[2])',
  diagnostic, String(code)], options)

test('known GNOME window/proxy/exec failures cannot succeed with an exit-zero launcher', async () => {
  for (const diagnostic of [
    '# Error creating terminal: The name org.gnome.Terminal was not provided by any .service files\n',
    '# Failed to create proxy for terminal: fixture proxy failure\n',
    '# Error: fixture exec failure\n',
  ]) {
    const child = fixture(diagnostic)
    await assert.rejects(acknowledgeGnomeTerminal(child), error => {
      assert.equal(error.message, 'PROVIDER_LOGIN_TERMINAL_UNCONFIRMED')
      assert.equal(error.message.includes(diagnostic), false)
      return true
    })
    assert.equal(child.exitCode, 0)
  }
})

test('ordinary GNOME warnings and recoverable preferred-server fallback permit acceptance', async () => {
  for (const diagnostic of ['',
    '# AT-SPI: Error retrieving accessibility bus address: fixture\n'
      + '# Failed to use specified server: fixture\n# Falling back to default server.\n',
    '# Warning: Error creating terminal: appears inside a warning, not a failure prefix\n',
  ]) await acknowledgeGnomeTerminal(fixture(diagnostic))
})

test('nonzero, signal and missing launcher remain unconfirmed without exposing stderr', async () => {
  await assert.rejects(acknowledgeGnomeTerminal(fixture('private diagnostic', 3)), /TERMINAL_UNCONFIRMED/)
  const signalled = spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], options)
  await assert.rejects(acknowledgeGnomeTerminal(signalled), /TERMINAL_UNCONFIRMED/)
  await assert.rejects(acknowledgeGnomeTerminal(spawn(
    '/tools-enabled-fixture-does-not-exist/gnome-terminal', [], options,
  )), /TERMINAL_UNCONFIRMED/)
})

test('diagnostic overflow is uncertain and drains without killing the launcher', async () => {
  const child = spawn(process.execPath, ['-e',
    'process.stderr.write("x".repeat(Number(process.argv[1])))', String(MAX_DIAGNOSTIC_BYTES + 1)], options)
  await assert.rejects(acknowledgeGnomeTerminal(child), /TERMINAL_UNCONFIRMED/)
  assert.equal(child.exitCode, 0)
  assert.equal(child.killed, false)
})

test('a deadline reports uncertainty while the launcher continues to its normal exit', async () => {
  const child = spawn(process.execPath, ['-e',
    'setTimeout(() => process.stderr.write("# Error: late fixture failure\\n"), 150)'], options)
  const closed = once(child, 'close')
  await assert.rejects(acknowledgeGnomeTerminal(child, { timeoutMs: 20 }), /TERMINAL_UNCONFIRMED/)
  assert.equal(child.killed, false)
  assert.equal(child.exitCode, null)
  assert.deepEqual(await closed, [0, null])
})
