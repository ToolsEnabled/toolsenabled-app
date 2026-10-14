/* ONE OWNER DECISION, MINTED AS A REAL GRANT, AND SPENDABLE ONCE.
 *
 * WHY A DRIVER AS WELL AS A SUITE. tools/test/vault-credential-approval.test.mjs
 * counts mints and dispatches over an injected dispatch, which is the right
 * shape for a unit suite. It cannot show that a grant this shell mints is a
 * grant the PRODUCT accepts -- that needs the payload's approvals module, its
 * policy and a real state store, none of which are in this repository. This
 * runs the actual `createOwnerApprovedRemover` against all three in a
 * throwaway database.
 *
 * WHAT IT PROVES.
 *   - Whether this installation gates `system.credential_remove` at all, asked
 *     through `loadPolicy` + `requiresApproval` -- the same two functions the
 *     dispatch asks, which is why shell/agent-confinement-read.cjs asks them.
 *   - That the grant this shell mints is accepted by `consumeApprovalGrant`,
 *     the function `approvals.consume` calls inside the dispatch, for this
 *     exact action and these exact arguments.
 *   - That the same token is then refused APPROVAL_ALREADY_USED.
 *   - That a grant minted for one vault key is refused
 *     APPROVAL_BINDING_MISMATCH for another, and for a different action.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, AND THE MEASUREMENT BEHIND THAT.
 * It does not dispatch the real destructive tool. Measured on this machine:
 * `executeTool('system.credential_remove', …)` did not return within 120
 * seconds -- that dispatch spawns the vault program and writes durable audit,
 * and on a staged payload the lifecycle program is missing anyway (see
 * tools/test/vault-manager-staged.test.mjs). So the end-to-end destructive
 * dispatch is NOT covered here and is not claimed: this is "could not look" on
 * that one step, and the grant link either side of it is measured.
 *
 * NO CREDENTIAL VALUE IS INVOLVED. This path carries a key NAME and a bounded
 * reason. The keys below are synthetic and name nothing real. No vault is
 * opened, written or read by this driver.
 *
 * REFUSES BY NAME rather than passing quietly: exit 3, the same exit and reason
 * tools/check-test-inputs.mjs uses, when no payload is named.
 *
 * Usage:
 *   node tools/vault-removal-approval-qa.mjs [--release <win-unpacked>]
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { qaCapabilityPayload } from './lib/qa-capability-payload.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')
const SYNTHETIC_KEY = 'w87_probe_absent'
const OTHER_KEY = 'w87_probe_other'
const REASON = 'no_longer_needed'

function refuse(reason) {
  process.stdout.write(`vault-removal-approval-qa: NOT MEASURED -- ${reason}\n`)
  process.exit(3)
}

const payload = qaCapabilityPayload()
if (!payload) {
  refuse('neither --release nor MC_TEST_CAPABILITY_PAYLOAD names a payload, so the real approvals module, policy '
    + 'and state store could not be reached. capability/ is derived output and gitignored here.')
}

let approvals
let stateStore
let policy
let registry
let planner
try {
  approvals = require_(path.join(payload, 'src', 'lib', 'approvals.js'))
  stateStore = require_(path.join(payload, 'src', 'lib', 'state-store.js'))
  policy = require_(path.join(payload, 'src', 'lib', 'policy.js'))
  registry = require_(path.join(payload, 'src', 'lib', 'tool-registry.js'))
  planner = require_(path.join(payload, 'src', 'lib', 'agent-session-confinement.js'))
} catch (error) {
  refuse(`${payload} could not supply its own modules (${error?.code || error?.message})`)
}

const { TOOL, createOwnerApprovedRemover } = require_(path.join(ROOT, 'shell', 'vault-credential-approval.cjs'))

/* The installation's own verified account temp, per ACCOUNT-FENCE.md -- never
   os.tmpdir(), which reads inherited profile variables. */
const profileRoot = planner.installationProfileRoot()
const fixtureTemp = planner.assertAccountProfilePath(
  path.join(profileRoot, 'AppData', 'Local', 'Temp'),
  { field: 'vault-removal-approval-qa fixture temp', profileRoot, requireOwnedProfile: true },
)

/* Stated, never defaulted -- the rule the dispatch enforces. The shell uses
   recordedInstallSession(), which needs a machine record a bare checkout has
   none of, so this states the shape shell/tree-lifecycle-authority.cjs states
   for a local confined dispatch. Nothing here dispatches, so this is carried
   only to prove the remover refuses to be built without one. */
const permissionSession = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' })

let failures = 0
function check(condition, sentence) {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'} ${sentence}\n`)
  if (!condition) failures += 1
}

const directory = mkdtempSync(path.join(fixtureTemp, 'w87-removal-approval-'))
let store = null
try {
  store = stateStore.createStateStore({ file: path.join(directory, 'state.sqlite3') })

  /* 1  DOES THIS INSTALLATION GATE THE TOOL -- asked the way the dispatch asks. */
  const entry = registry.registeredTools().find(tool => tool.name === TOOL)
  let gated = null
  try {
    gated = Boolean(entry) && entry.approvalEligible === true
      && policy.requiresApproval(TOOL, entry.effect, policy.loadPolicy()) === true
  } catch (error) {
    process.stdout.write(`  could not read the approval policy (${error?.code || error?.message})\n`)
  }
  process.stdout.write(`vault-removal-approval-qa: ${TOOL} approvalEligible=${entry?.approvalEligible} gatedHere=${gated}\n`)
  check(entry?.approvalEligible === true,
    'the tool is approval-eligible, which is why a carried decision is needed at all')

  /* 2  THE REMOVER, REAL, minting into the real store. Its dispatch is the one
        thing stubbed, and only to keep this driver from running a destructive
        verb -- the stub refuses without a token exactly as the gate does, so
        the mint happens for the reason it happens in the product. */
  const mints = []
  const audits = []
  const remover = createOwnerApprovedRemover({
    executeTool: async (name, args) => {
      if (args.approvalToken === undefined) {
        throw Object.assign(new Error('gate'), { code: 'APPROVAL_REQUIRED' })
      }
      /* The decisive step: hand the carried token to the same store function
         `approvals.consume` calls inside the dispatch, with the arguments the
         dispatch would hash after stripping the token. */
      const { approvalToken, ...executionArguments } = args
      const grant = store.consumeApprovalGrant({
        action: name,
        inputHash: approvals.actionInputHash(name, executionArguments),
        tokenHash: approvals.tokenHash(approvalToken),
      })
      return { consumed: grant.status }
    },
    createGrant: grant => { mints.push(grant); return store.createApprovalGrant(grant) },
    inputHash: approvals.actionInputHash,
    tokenHash: approvals.tokenHash,
    permissionSession,
    onGrant: entryValue => audits.push(entryValue),
  })

  const carried = await remover({ vaultKey: SYNTHETIC_KEY, reason: REASON, ownerPromptId: 'w87-owner-prompt' })
    .then(answer => answer.consumed, error => error?.code)
  process.stdout.write(`  the carried grant was: ${carried}\n`)
  check(carried === 'consumed',
    'the grant this shell minted was accepted by the product for this exact removal')
  check(mints.length === 1, `exactly one grant was minted for one owner decision (${mints.length})`)
  check(audits.length === 1 && audits[0].ownerPromptId === 'w87-owner-prompt',
    'the grant is recorded against the owner decision that authorised it')
  check(!JSON.stringify(audits).includes(mints[0].tokenHash)
    && !Object.values(audits[0]).some(value => typeof value === 'string' && value.length === 43),
    'no token, and no token-shaped string, reached the audit record')

  /* 3  ONE USE. The token the remover just spent cannot be spent again. */
  const replay = (() => {
    try {
      return store.consumeApprovalGrant({
        action: TOOL,
        inputHash: approvals.actionInputHash(TOOL, { vaultKey: SYNTHETIC_KEY, reason: REASON }),
        tokenHash: mints[0].tokenHash,
      }).status
    } catch (error) { return error?.code }
  })()
  check(replay === 'APPROVAL_ALREADY_USED', `the grant the removal spent is refused a second time (${replay})`)

  /* 4  BOUND TO THE RECORD THE OWNER SAW, and to this tool. A fresh grant,
        offered for the wrong key and for the wrong action. */
  const token = randomBytes(32).toString('base64url')
  store.createApprovalGrant({
    action: TOOL,
    inputHash: approvals.actionInputHash(TOOL, { vaultKey: SYNTHETIC_KEY, reason: REASON }),
    tokenHash: approvals.tokenHash(token),
    expiresAtMs: Date.now() + 60_000,
  })
  const offer = (action, args) => {
    try {
      return store.consumeApprovalGrant({
        action, inputHash: approvals.actionInputHash(action, args), tokenHash: approvals.tokenHash(token),
      }).status
    } catch (error) { return error?.code }
  }
  const wrongKey = offer(TOOL, { vaultKey: OTHER_KEY, reason: REASON })
  check(wrongKey === 'APPROVAL_BINDING_MISMATCH',
    `a grant for ${SYNTHETIC_KEY} is refused for ${OTHER_KEY} (${wrongKey})`)
  const wrongAction = offer('system.credential_request', { vaultKey: SYNTHETIC_KEY, reason: REASON })
  check(wrongAction === 'APPROVAL_BINDING_MISMATCH' || wrongAction === 'APPROVAL_NOT_FOUND',
    `a removal approval is refused for another tool (${wrongAction})`)
  const rightKey = offer(TOOL, { vaultKey: SYNTHETIC_KEY, reason: REASON })
  check(rightKey === 'consumed',
    `the same grant is still good for the record it was minted for (${rightKey}) -- the refusals above are binding, not breakage`)
} finally {
  try { store?.close?.() } catch { /* the directory removal below is the cleanup that matters */ }
  try { rmSync(directory, { recursive: true, force: true }) } catch { /* a live sqlite handle on Windows */ }
  process.stdout.write('  removed the throwaway approval database\n')
}

if (failures > 0) {
  process.stdout.write(`vault-removal-approval-qa: ${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write('vault-removal-approval-qa: one owner decision, minted once, spendable once, bound to the record it was about.\n')
