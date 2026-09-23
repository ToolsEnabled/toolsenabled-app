/* THE SCRATCH DIRECTORY THE RELEASE MEASUREMENT OWNS, AND ITS MODE.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE tools/test-strict.mjs.
 *
 * Measured 2026-09-11 on Linux at app 906ea9d0 with a default umask of 002:
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
import path from 'node:path'

/* 0o700 and not 0o750: the walk in shell/linux-account-state.cjs refuses any
   group or other bit, and narrows what it accepts to exactly this. */
export const SCRATCH_MODE = 0o700

/**
 * Create `state/` and `temp/` under `scratch` and make all three owner-private.
 *
 * Returns `{ ok: true, scratch, state, temp }`, or `{ ok: false, reason:
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
  return { ok: true, scratch, state, temp }
}
