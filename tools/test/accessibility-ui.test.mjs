import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { computeDisplayGuardDecision } from '../lib/accessibility-ui-display-guard.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')

// Use a private Xvfb display on Linux, retaining the required native check.
// An unavailable display is a named failure, including nightly runs.

const REAL_DISPLAY_OPT_IN = 'TOOLSENABLED_ACCESSIBILITY_UI_ALLOW_REAL_DISPLAY'

function resolveXvfbRun() {
  if (process.platform !== 'linux') return false
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  return !probe.error && probe.status === 0
}

const hasXvfbRun = resolveXvfbRun()
const hasDisplay = typeof process.env.DISPLAY === 'string' && process.env.DISPLAY !== ''
const hasRealDisplayOptIn = process.env[REAL_DISPLAY_OPT_IN] === '1'

// The display guard (xvfb-run/ambient-DISPLAY/refuse/unavailable) only makes sense
// where X11 DISPLAY semantics exist, i.e. Linux. On every other platform
// (Windows, macOS) there is no DISPLAY concept to leak, so the decision is
// always 'direct': launch Electron the same way this test always did before
// R96, unconditionally, on every platform.
const guardDecision = computeDisplayGuardDecision({ platform: process.platform, hasXvfbRun, hasDisplay })

test('real native app controls: owner opt-in, exact confirmation, click/type/select, stale refusal and stop', { timeout: 30000 }, async () => {
  if (guardDecision === 'unavailable') {
    const error = new Error('The required native app control check needs xvfb-run on Linux, or an explicitly approved disposable DISPLAY.')
    error.code = 'ACCESSIBILITY_UI_DISPLAY_UNAVAILABLE'
    throw error
  }

  if (guardDecision === 'refuse' && !hasRealDisplayOptIn) {
    const error = new Error(
      `refusing to launch a real Electron window against DISPLAY=${JSON.stringify(process.env.DISPLAY)}: ` +
      'xvfb-run is not available to isolate it, and this could be the operator\'s own live desktop. ' +
      `Set ${REAL_DISPLAY_OPT_IN}=1 only if DISPLAY is already known to be an isolated/disposable display.`
    )
    error.code = 'ACCESSIBILITY_UI_REAL_DISPLAY_REFUSED'
    throw error
  }

  const dataRoot = await mkdtemp(path.join(tmpdir(), 'toolsenabled-accessibility-ui-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
  const electronBinary = require('electron')
  const helperArgs = [path.join(root, 'tools/test/helpers/accessibility-ui-electron.cjs'), dataRoot]
  const [command, args] = guardDecision === 'wrap'
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', electronBinary, ...helperArgs]]
    : [electronBinary, helperArgs]
  const { stdout } = await promisify(execFile)(command, args, {
    cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024,
  })
  const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.ok === true)
  assert.deepEqual(result, { ok: true, controls: 3, clicks: 1, typed: true, selected: true, staleRefused: true,
    stopped: true, documentSwapsRefused: 2, productionDocumentSwapsRefused: 3, reenabledHashNavigations: 3 })
})
