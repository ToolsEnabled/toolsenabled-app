import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { nightlySkipReason, nightlySuitesEnabled } from '../lib/test-suite-result.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { sterileLaunchEnvironment, prepareSterileProfile, sterileProfileDirectories } = require('../lib/sterile-launch.cjs')

/* NIGHTLY, NOT SILENT, AND NOT WEAKENED. This launches a REAL Electron
 * process and waits for a real renderer to answer, so its result depends on an
 * interactive desktop and on what else the machine is doing. MEASURED
 * 2026-09-07 at app 4ba0ceac: in a whole-suite run with four other test runs on
 * the machine the child hit its own 25000ms limit at 27031ms and the case was
 * reported as "Command failed: ...electron.exe ... --check" with no message at
 * all -- a busy machine reported as a camera-permissions defect. Run alone
 * moments later, on the same commit, it passed. The assertions are unchanged
 * and it runs in full under TOOLSENABLED_NIGHTLY=1; the release run counts it
 * as unexecuted coverage BY NAME. See RELEASE_SKIP_REGISTER in
 * tools/lib/test-suite-result.mjs. */
test('native camera permissions, pinch clicks, background pause, and complete off cleanup', {
  skip: nightlySuitesEnabled() ? false : nightlySkipReason('hand-controls-native-renderer-check'),
  timeout: 30000,
}, async () => {
  /* MEASUREMENT INTEGRITY, not a privacy sweep. This line used to name one
   * machine's Temp directory as a literal, so the scratch went to the real
   * user temp no matter what TEMP/TMP the run had pinned -- MEASURED
   * 2026-09-07: a run pinned to a scratch root still wrote
   * `...\AppData\Local\Temp\hand-controls-ui-Rg44hg`. os.tmpdir() reads the
   * pinned value, so an isolated run is actually isolated. Elsewhere in this
   * repository the same profile literal is the account FENCE and is meant to
   * be there (tools/lib/release-readiness.mjs, tools/lib/transport/
   * QualificationVm.psm1); scrubbing owner paths at the release cut is a
   * different piece of work with its own owner ruling, and this is not it. */
  const data = await mkdtemp(path.join(os.tmpdir(), 'hand-controls-ui-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(data)))
  const { stdout } = await promisify(execFile)(require('electron'), [path.join(root, 'tools/hand-controls-practice.cjs'), data, '--check'], {
    cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024,
  })
  const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.ok)
  assert.ok(result, 'Actual renderer checks must complete')
})
