/* THE SCRATCH DIRECTORY THE RELEASE MEASUREMENT OWNS, AND ITS MODE.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE tools/test-strict.mjs.
 *
 * Measured 2026-09-11 on Linux at an earlier app commit with a default umask of 002:
 * `node tools/test-strict.mjs --canonical-root <engine>` reported
 *
 *   Ran 12452 tests: 12327 pass, 20 fail, 105 skipped
 *   STRICT VERIFICATION FAILED -- all test failures block release
 *
 * and all 20 were the permissions of the three directories the runner creates
 * for itself. shell/linux-account-state.cjs:48 walks the state-root path and
 * refuses any component that is not owner-private -- "The application could not
 * prepare private account storage. Choose an owned, private user-data directory
 * without symbolic links." -- which took out linux-account-state (3),
 * product-settings-batch (1) and settings-tool-policy-contract (1);
 * audit-identity-native reported SECRET_VAULT_PATH_UNSAFE (15) for the vault
 * beneath the same root. Every one of those refusals is the product being
 * right. Re-running the same suites against a 0o700 scratch, nothing else
 * changed: linux-account-state 8/8.
 *
 * mkdtempSync already creates the runner's DEFAULT scratch 0o700, so only the
 * two children were wrong on that path -- and a --scratch directory arrives
 * with whatever umask the caller had. That is the kind of fact that has to be
 * PINNED rather than remembered, and it cannot be pinned where it was: the
 * runner refuses an invalid --canonical-root long before it prepares a scratch,
 * so no test could drive it there without either a 13-minute real measurement
 * or a path from this machine, which that command's own header forbids. So the
 * decision lives here, the runner calls it, and tools/test/test-scratch-root.test.mjs
 * drives it directly.
 */

import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const { CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES } = createRequire(import.meta.url)('../../shell/capability-path-environment.cjs')

/* 0o700 and not 0o750: the walk in shell/linux-account-state.cjs refuses any
   group or other bit, and narrows what it accepts to exactly this. */
export const SCRATCH_MODE = 0o700

/* WHERE THE NATIVE CUSTODY SUITES MAY WRITE ON WINDOWS. The same leaf, under the
   same temp root, that tools/release-packager/cut-release-candidate.mjs
   nativeQualificationRoot() gives a cut, so a strict measurement and a cut hand
   those suites the same shape of directory. */
export const NATIVE_QUALIFICATION_LEAF = 'native-qualification'

/**
 * Create `state/` and `temp/` under `scratch`, and `native-qualification/`
 * under `temp/`, and make all of them owner-private.
 *
 * Returns `{ ok: true, scratch, state, temp, native }`, or `{ ok: false, reason:
 * 'not-empty', entries }` when `scratch` holds more than the two directories
 * this function creates. The root is narrowed ONLY in the ok case: `--scratch`
 * is documented as an empty directory but was never checked, so narrowing it
 * unconditionally would let `--scratch ~` set a home directory to 0o700.
 */
export function prepareStrictScratch(scratch) {
  if (typeof scratch !== 'string' || scratch.trim() === '' || !path.isAbsolute(scratch)) {
    throw new TypeError('The strict scratch directory must be an absolute path.')
  }
  const state = path.join(scratch, 'state')
  const temp = path.join(scratch, 'temp')
  mkdirSync(state, { recursive: true, mode: SCRATCH_MODE })
  mkdirSync(temp, { recursive: true, mode: SCRATCH_MODE })

  /* Both children have just been created, so anything beyond them means the
     caller passed a directory that is already in use -- worth refusing on its
     own account, and the thing that makes narrowing the root safe. */
  const entries = readdirSync(scratch)
  if (entries.length > 2) return { ok: false, reason: 'not-empty', entries: entries.length }

  /* mkdirSync's `mode` is masked by the process umask, so the directories can
     come back wider than asked for even on the path that names a mode. Set it
     explicitly, and only after the emptiness check above. */
  for (const directory of [scratch, state, temp]) {
    if ((statSync(directory).mode & 0o7777) !== SCRATCH_MODE) chmodSync(directory, SCRATCH_MODE)
  }
  /* The native custody suites lstat every ancestor and realpath this root, so
     it has to exist before the measurement starts, not be made by its first
     case. Under temp/, so the root itself still holds only its two children. */
  const native = path.join(temp, NATIVE_QUALIFICATION_LEAF)
  mkdirSync(native, { recursive: true, mode: SCRATCH_MODE })
  if ((statSync(native).mode & 0o7777) !== SCRATCH_MODE) chmodSync(native, SCRATCH_MODE)
  return { ok: true, scratch, state, temp, native }
}

/* THE MEASUREMENT'S ENVIRONMENT, AS THE CUT BUILDS ITS OWN (T308).
 *
 * The cut started as a mirror of tools/test-strict.mjs's scratch set and then
 * learned three things this runner never did. Each was a measured false red or
 * a write into the owner's installation, recorded where the cut fixed it in
 * tools/release-packager/cut-release-candidate.mjs buildDistChainEnvironment():
 *
 *   - Every inherited capability path override goes, not only the state root
 *     and vault this runner re-points. The shell of an agent on a machine that
 *     runs this product carries them into the running installation; unset,
 *     each one defaults from the scratch state root instead.
 *   - MC_SETTINGS_NATIVE_SCRATCH_ROOT names a directory this measurement owns.
 *     tools/test/audit-repair-native.test.mjs refuses its native Windows cases
 *     without it; the 1.0.45 cut hit that sentence 14 times inside
 *     verify:release.
 *   - On Windows, PSModulePath is emptied, so a PowerShell 7 parent's module
 *     directories cannot reach the Windows PowerShell 5.1 children the suites
 *     start (22 reds on the 1.0.45 cut; emptied, the same 45 tests passed).
 *
 * The rest is the scratch set this runner always wrote, unchanged. The cut's
 * other fences (workspace names, payload gates, provider homes, profile
 * directories) belong to building a distributable and are not copied here. */
export function strictMeasurementEnvironment(processEnv, {
  state, temp, native, canonicalRoot, nightly = false, platform = process.platform,
} = {}) {
  for (const [name, value] of Object.entries({ state, temp, native, canonicalRoot })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new TypeError(`The strict measurement environment needs an absolute ${name} directory.`)
    }
  }
  const environment = { ...processEnv }
  for (const name of CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES) delete environment[name]
  Object.assign(environment, {
    TOOLSENABLED_TEST_STRICT: '1',
    TOOLSENABLED_STATE_ROOT: state,
    MC_TEST_STATE_ROOT: state,
    // The vault path is the other inherited pointer. An agent shell on a
    // machine that runs this product carries TOOLSENABLED_VAULT_PATH into the
    // running installation's profile, and the engine resolves it before the
    // state root; name the scratch vault, in the layout the product uses.
    TOOLSENABLED_VAULT_PATH: path.join(state, 'vault', 'secrets.json'),
    TEMP: temp,
    TMP: temp,
    // TEMP/TMP are what Windows reads; Node resolves os.tmpdir() from TMPDIR
    // on POSIX, so a Linux child would otherwise still write outside scratch.
    TMPDIR: temp,
    MC_CANONICAL_ROOT: canonicalRoot,
    MC_SETTINGS_NATIVE_SCRATCH_ROOT: native,
  })
  if (platform === 'win32') environment.PSModulePath = ''
  if (nightly) environment.TOOLSENABLED_NIGHTLY = '1'
  else delete environment.TOOLSENABLED_NIGHTLY
  return environment
}
