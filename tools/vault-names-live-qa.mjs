/* THE VAULT NAME LISTING, AGAINST THE REAL VAULT PROGRAM.
 *
 * WHY A DRIVER AND NOT ANOTHER SUITE. tools/test/vault-credential-page.test.mjs
 * drives the seam over a STUBBED spawn, which is the right shape for a unit
 * suite and proves what the seam does with an answer. It cannot prove that
 * tools/secrets.ps1's `list` verb answers in the shape the seam parses, because
 * that program is not in this repository. This driver writes two obviously
 * synthetic records into a THROWAWAY vault under a temporary state root, runs
 * the real program through the real seam, checks the answer, and deletes the
 * vault it made.
 *
 * WHAT IT PROVES THAT THE SUITE CANNOT. That a real `list` prints names the
 * parser accepts, and that the values it wrote -- which are genuinely in that
 * vault, encrypted -- do not come back out through the name path.
 *
 * NO REAL CREDENTIAL IS INVOLVED. The two values are the synthetic placeholders
 * below. They are credentials for nothing and they go into a vault created for
 * this run and removed at the end of it. The owner's own vault is never
 * touched: the state root is a fresh temporary directory and
 * TOOLSENABLED_VAULT_PATH is cleared, which is what makes `secrets.ps1` resolve
 * the throwaway store rather than the installation's.
 *
 * IT REFUSES BY NAME RATHER THAN PASSING QUIETLY. The capability payload is
 * gitignored here (`/capability/` in .gitignore), so there is no path this file
 * may resolve on its own. Name one with --release <win-unpacked>, or with
 * MC_TEST_CAPABILITY_PAYLOAD when there is no candidate tree at hand. Without
 * either this driver exits 3 -- "nothing was measured" -- which is the same
 * exit and the same reason tools/check-test-inputs.mjs uses, because 0 would
 * claim a pass and 1 would claim a failure and neither would be true.
 *
 * Usage:
 *   node tools/vault-names-live-qa.mjs [--release <win-unpacked>]
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { qaCapabilityPayload } from './lib/qa-capability-payload.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')

/* Synthetic, and they say so. Written into a vault this run creates. */
const FIXTURE = Object.freeze({
  w87_probe_alpha: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-ALPHA',
  w87_probe_beta: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-BETA-2',
})

function refuse(reason) {
  process.stdout.write(`vault-names-live-qa: NOT MEASURED -- ${reason}\n`)
  process.exit(3)
}

const payload = qaCapabilityPayload()
if (!payload) {
  refuse('neither --release nor MC_TEST_CAPABILITY_PAYLOAD names a payload, so the real tools/secrets.ps1 could not '
    + 'be found. capability/ is derived output and gitignored here; run `npm run pack:capability`, point --release '
    + 'at a candidate, or name an existing payload.')
}
if (process.platform !== 'win32') {
  refuse(`this machine is ${process.platform}; tools/secrets.ps1 is the Windows vault program `
    + '(capability/src/lib/vault-platform.js states the vault is Windows-only for this version), so there is nothing to drive here.')
}
function payloadModule(relative) {
  try { return require_(path.join(payload, ...relative.split('/'))) } catch { return null }
}

const script = path.join(payload, 'tools', 'secrets.ps1')
if (!existsSync(script)) refuse(`${script} does not exist, so the vault program could not be run`)

const { vaultRecordNames } = require_(path.join(ROOT, 'shell', 'vault-presence.cjs'))

/* THE THROWAWAY VAULT GOES IN THE INSTALLATION'S OWN VERIFIED ACCOUNT TEMP, NOT
   os.tmpdir(). ACCOUNT-FENCE.md is the rule; os.tmpdir() reads inherited
   profile variables and on this machine can resolve the 8.3 short spelling of a
   profile, which the payload's own state-root fence refuses as not the
   account's own directory. The payload's planner is what decides this --
   installationProfileRoot() and assertAccountProfilePath(), the same pair
   tools/test/agent-confinement-provider.test.mjs uses -- so this driver cannot
   choose a directory the product would refuse. */
const planner = payloadModule('src/lib/agent-session-confinement.js')
if (typeof planner?.installationProfileRoot !== 'function' || typeof planner?.assertAccountProfilePath !== 'function') {
  refuse(`${payload} carries no src/lib/agent-session-confinement.js planner, so an account-owned temp directory could not be verified. `
    + 'ACCOUNT-FENCE.md forbids falling back to os.tmpdir() here.')
}
const profileRoot = planner.installationProfileRoot()
const fixtureTemp = planner.assertAccountProfilePath(
  path.join(profileRoot, 'AppData', 'Local', 'Temp'),
  { field: 'vault-names-live-qa fixture temp', profileRoot, requireOwnedProfile: true },
)
const stateRoot = mkdtempSync(path.join(fixtureTemp, 'w87-vault-live-'))
mkdirSync(path.join(stateRoot, 'vault'), { recursive: true })
/* The environment the seam itself builds: the throwaway state root named, and
   any inherited TOOLSENABLED_VAULT_PATH cleared so this cannot reach the
   installation's store. PSModulePath is emptied because a pwsh 7 value
   inherited into Windows PowerShell 5.1 breaks it on this machine. */
const childEnv = { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot, PSModulePath: '' }
delete childEnv.TOOLSENABLED_VAULT_PATH

let failures = 0
function check(condition, sentence) {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'} ${sentence}\n`)
  if (!condition) failures += 1
}

try {
  process.stdout.write(`vault-names-live-qa: throwaway vault under ${stateRoot}\n`)
  for (const [key, value] of Object.entries(FIXTURE)) {
    /* The value travels on stdin, never in argv -- the rule the real writers
       follow, for the reason src/lib/runtime.js states: another local process
       can read a command line. */
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', script, 'set-stdin', key,
    ], { env: childEnv, input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
  }
  process.stdout.write(`  wrote ${Object.keys(FIXTURE).length} synthetic record(s) into it\n`)

  const answer = await vaultRecordNames({ capabilityRoot: payload, stateRoot })
  process.stdout.write(`  answer: readable=${answer.readable} code=${answer.code} names=${JSON.stringify(answer.names)}\n`)

  check(answer.readable === true, 'the real vault program answered and the seam read it')
  for (const key of Object.keys(FIXTURE)) {
    check(Array.isArray(answer.names) && answer.names.includes(key), `the listing names the record ${key}`)
  }
  const strings = JSON.stringify(answer)
  for (const [key, value] of Object.entries(FIXTURE)) {
    check(!strings.includes(value), `the listing does not carry the value stored under ${key}`)
    check(!strings.includes(value.slice(0, 8)), `the listing does not carry a prefix of the value under ${key}`)
    check(!strings.includes(String(value.length)), `the listing does not carry the length of the value under ${key}`)
  }
  check(Object.keys(answer).every(field => ['readable', 'code', 'detail', 'store', 'names'].includes(field)),
    'the answer carries no field beyond the names and the reason')
} finally {
  /* The vault this run made goes away with it, whatever happened above. */
  rmSync(stateRoot, { recursive: true, force: true })
  process.stdout.write(`  removed the throwaway vault at ${stateRoot}\n`)
}

if (failures > 0) {
  process.stdout.write(`vault-names-live-qa: ${failures} check(s) failed against the real vault program\n`)
  process.exit(1)
}
process.stdout.write('vault-names-live-qa: the real vault program lists names, and no value, prefix or length came back.\n')
