/* THE WHOLE REMOVAL, THROUGH THE REAL DISPATCH -- FENCED OFF THE OWNER'S OWN
 * INSTALLATION.
 *
 * THE FENCE IS NOT IN THIS FILE. It is tools/lib/vault-scratch-fence.mjs, a
 * module with no top level, and that separation is itself a fix: while the
 * fence was exported from this driver, a proof that imported the driver to
 * call the fence RAN THE DRIVER -- `await import()` executes a script -- and
 * performed a full seeded removal that was under an explicit instruction not
 * to run. It ran fenced and reached no live artefact, but the instruction was
 * not to run it. A fence that has to be importable cannot live in a script.
 *
 * WHAT THIS MEASURES
 *
 *   1  the real `recordedInstallSession()` over a real machine record answers
 *      a ceiling
 *   2  a dispatch with NO token is refused APPROVAL_REQUIRED -- the second
 *      prompt the owner met after already approving at #/approvals
 *   3  the same dispatch with the carried grant gets PAST every approval
 *      check. Asserted as "no APPROVAL_* code at all", never as "not
 *      APPROVAL_REQUIRED": that narrower form passed on APPROVAL_NOT_FOUND,
 *      APPROVAL_BINDING_MISMATCH, APPROVAL_ALREADY_USED and APPROVAL_EXPIRED,
 *      so it ran and could not fail the way its own sentence claimed.
 *   4  the seeded record is GONE from the fenced vault afterwards -- read
 *      back, not inferred from the call returning
 *   5  a token minted for one credential name is refused for another, and a
 *      token already spent is refused. Executed, not read.
 *
 * `--prove-fence` stops after the fence, so it can be shown without any
 * dispatch at all.
 *
 * NO CREDENTIAL VALUE IS INVOLVED: a removal carries a key NAME and a bounded
 * reason. The keys and the seeded value are synthetic. The only vault this run
 * can reach is inside its own scratch root.
 *
 * Usage:
 *   node tools/vault-removal-end-to-end-qa.mjs [--release <win-unpacked>]
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  FENCE_ENV,
  ScratchFenceRefusal,
  assertScratchFence,
  fenceRequiredNames,
  fencedEnvironment,
} from './lib/vault-scratch-fence.mjs'
import { qaCapabilityPayload } from './lib/qa-capability-payload.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')
const OWNED_KEY = 'w87_e2e_owned'
const OTHER_KEY = 'w87_e2e_other'
const REASON = 'no_longer_needed'
const OWNER_PROMPT = 'w87-e2e-owner-prompt'
/* ------------------------------------------------------------------------
 * The driver.
 * ------------------------------------------------------------------------ */

/* IMPORTING THIS FILE MUST NOT RUN IT. Controller's find, and it is the exact
 * trap that produced three prohibited runs of this driver: moving the FENCE
 * into a module with no top level stopped the fence being
 * importable-and-executable, but the DRIVER still had a live top level, so
 * `await import()` of it still executed -- Controller demonstrated it printing
 * its NOT MEASURED refusal on import.
 *
 * "Nobody should import this" is a convention somebody breaks at 02:00.
 * "Importing this cannot run it" is a property. This is the property.
 */
const RUN_AS_ENTRY = (() => {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try { return import.meta.url === pathToFileURL(entry).href } catch { return false }
})()

function refuse(reason) {
  process.stdout.write(`vault-removal-end-to-end-qa: NOT MEASURED -- ${reason}\n`)
  process.exit(3)
}

/* Everything below this line is the driver. Imported, none of it happens; the
   guard is checked before the first read of the environment so even the
   NOT MEASURED refusal cannot fire on an import. */
if (!RUN_AS_ENTRY) {
  /* Imported. Nothing runs. Exported nothing on purpose: the fence is
     tools/lib/vault-scratch-fence.mjs, and anyone wanting it should import
     that, not this. */
} else await runDriver()

async function runDriver() {
const payload = qaCapabilityPayload()
if (!payload) {
  refuse('neither --release nor MC_TEST_CAPABILITY_PAYLOAD names a payload, so the real tool registry could not '
    + 'be reached. capability/ is derived output and gitignored here.')
}

/* PHASE 1 -- create the scratch root, then re-execute inside it. */
if (!process.env[FENCE_ENV]) {
  let planner
  try {
    planner = require_(path.join(payload, 'src', 'lib', 'agent-session-confinement.js'))
  } catch (error) {
    refuse(`${payload} could not supply its confinement planner (${error?.code || error?.message})`)
  }
  /* The installation's own verified account temp, per ACCOUNT-FENCE.md -- never
     os.tmpdir(), which reads inherited profile variables. */
  const profileRoot = planner.installationProfileRoot()
  const fixtureTemp = planner.assertAccountProfilePath(
    path.join(profileRoot, 'AppData', 'Local', 'Temp'),
    { field: 'vault-removal-end-to-end-qa fixture temp', profileRoot, requireOwnedProfile: true },
  )
  const scratch = mkdtempSync(path.join(fixtureTemp, 'w87-e2e-'))
  const { environment, directories } = fencedEnvironment(scratch)
  for (const directory of directories) mkdirSync(directory, { recursive: true })
  process.stdout.write(`vault-removal-end-to-end-qa: scratch root ${scratch}\n`)
  process.stdout.write(`  redirected ${fenceRequiredNames().length} required name(s) inside it, then re-executing\n`)
  const child = spawnSync(process.execPath, [import.meta.filename, ...process.argv.slice(2)], {
    env: environment, stdio: 'inherit', windowsHide: true, shell: false,
  })
  /* SAY WHAT ACTUALLY HAPPENED. This printed "removed the scratch root"
     unconditionally, including when rmSync threw on a live sqlite handle -- so
     nine of these roots accumulated in the account temp and the line said they
     had not. A cleanup message that cannot report a failed cleanup is how you
     stop noticing (R1231). */
  let removed = false
  let removalReason = ''
  try {
    rmSync(scratch, { recursive: true, force: true })
    removed = !existsSync(scratch)
    if (!removed) removalReason = 'the directory is still there after rmSync'
  } catch (error) {
    removalReason = error?.code || error?.message || 'rmSync threw'
  }
  process.stdout.write(removed
    ? '  removed the scratch root\n'
    : `  COULD NOT REMOVE the scratch root (${removalReason}): ${scratch}\n`
      + '  Remove it by hand; a sqlite handle can outlive the child on Windows.\n')
  process.exit(child.status === null ? 1 : child.status)
}

/* PHASE 2 -- the fence, then the measurement. */
process.stdout.write('vault-removal-end-to-end-qa: resolving the paths this run would actually use\n')
let fenced
try {
  fenced = assertScratchFence({
    payload,
    scratchRoot: process.env[FENCE_ENV],
    onCleared: (label, full) => process.stdout.write(`  fenced  ${label}: ${full}\n`),
  })
} catch (error) {
  if (error instanceof ScratchFenceRefusal) {
    process.stdout.write(`vault-removal-end-to-end-qa: REFUSED -- ${error.message}\n`)
    process.exit(4)
  }
  throw error
}
const scratchRoot = path.resolve(process.env[FENCE_ENV])

/* Now, and only now, the modules that can open, spawn and write. */
let registry
let approvals
let stateStore
let sessions
let machineRecord
try {
  registry = require_(path.join(payload, 'src', 'lib', 'tool-registry.js'))
  approvals = require_(path.join(payload, 'src', 'lib', 'approvals.js'))
  stateStore = require_(path.join(payload, 'src', 'lib', 'state-store.js'))
  sessions = require_(path.join(payload, 'src', 'lib', 'dispatch-permission-session.js'))
  machineRecord = require_(path.join(payload, 'src', 'lib', 'setup', 'machine-record.js'))
} catch (error) {
  refuse(`${payload} could not supply its own modules (${error?.code || error?.message})`)
}
/* The other half of the database question, now that the constant is loadable:
   where the store WOULD land if the variable were ever ignored. Through the
   same one function, so it refuses in the same words. */
try {
  assertScratchFence({
    payload,
    scratchRoot,
    alsoClear: { 'state database the store would choose on its own': stateStore.DEFAULT_STATE_PATH },
    onCleared: (label, full) => {
      if (label.startsWith('state database the store')) process.stdout.write(`  fenced  ${label}: ${full}\n`)
    },
  })
} catch (error) {
  if (error instanceof ScratchFenceRefusal) {
    process.stdout.write(`vault-removal-end-to-end-qa: REFUSED -- ${error.message}\n`)
    process.exit(4)
  }
  throw error
}

/* THE LEDGER PATH, CHECKED AGAINST THE MODULE THAT OWNS IT.
 *
 * The fence has to derive the ledger purely, because requiring audit-store.js
 * creates the state-root directory (its DEFAULT_AUDIT_DB is
 * rootPath('state','audit.sqlite3') evaluated at load) -- so the fence cannot
 * ask the module where the ledger is without the module making a directory to
 * answer. But a derivation nobody checks is a second copy of somebody else's
 * rule, which is the thing this lane keeps finding.
 *
 * So: derive it before the fence, then here -- AFTER the fence has cleared and
 * requiring is safe -- confirm the derivation is what audit.js would actually
 * choose. `boundLedgerFile` is not exported, so the two inputs it reads are
 * compared directly: TOOLSENABLED_AUDIT_DB when set, else DEFAULT_AUDIT_DB. */
const auditStore = require_(path.join(payload, 'src', 'lib', 'audit-store.js'))
const ledgerAuditWouldChoose = typeof process.env.TOOLSENABLED_AUDIT_DB === 'string'
  && process.env.TOOLSENABLED_AUDIT_DB.trim()
  ? path.resolve(process.env.TOOLSENABLED_AUDIT_DB.trim())
  : path.resolve(auditStore.DEFAULT_AUDIT_DB)
if (path.resolve(fenced.auditLedger) !== ledgerAuditWouldChoose) {
  process.stdout.write('vault-removal-end-to-end-qa: REFUSED -- the ledger this fence cleared is not the ledger '
    + `audit.js would use.\n    fenced:   ${path.resolve(fenced.auditLedger)}\n`
    + `    audit.js: ${ledgerAuditWouldChoose}\n`
    + '    A fence over a path the product does not use proves nothing.\n')
  process.exit(4)
}
process.stdout.write(`  checked  the fenced ledger is the one audit.js would choose: ${ledgerAuditWouldChoose}\n`)

if (process.argv.includes('--prove-fence')) {
  process.stdout.write('vault-removal-end-to-end-qa: every path cleared the fence and no dispatch was made.\n')
  process.exit(0)
}

/* WRITING AND READING THE FENCED VAULT, THROUGH THE VAULT'S OWN PROGRAM.
   Both take the vault file the fence CLEARED and pass it explicitly, so neither
   can drift onto a path the fence did not judge. The value travels on stdin,
   never in a command line. */
const SYNTHETIC_VALUE = 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-E2E'
let seededWhy = ''
function vaultProgramEnvironment(vaultFile) {
  return { ...process.env, TOOLSENABLED_VAULT_PATH: vaultFile, PSModulePath: '' }
}
function listFencedVaultNames(vaultFile) {
  const script = path.join(payload, 'tools', 'secrets.ps1')
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', script, 'list',
    ], {
      env: vaultProgramEnvironment(vaultFile), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
    })
    if (result.status !== 0) return null
    return String(result.stdout || '').split(/\r?\n/)
      .map(line => line.trim()).filter(line => /^[A-Za-z0-9_.-]+$/.test(line))
  } catch { return null }
}
function seedSyntheticRecord(vaultFile) {
  const script = path.join(payload, 'tools', 'secrets.ps1')
  try {
    spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', script, 'set-stdin', OWNED_KEY,
    ], {
      env: vaultProgramEnvironment(vaultFile), input: SYNTHETIC_VALUE, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    })
    const names = listFencedVaultNames(vaultFile)
    if (names === null) { seededWhy = 'the fenced vault could not be read back'; return false }
    if (!names.includes(OWNED_KEY)) { seededWhy = 'the record did not appear in the fenced vault'; return false }
    return true
  } catch (error) {
    seededWhy = error?.code || error?.message || 'the vault program could not be run'
    return false
  }
}

let failures = 0
function check(condition, sentence) {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'} ${sentence}\n`)
  if (!condition) failures += 1
}
const codeOf = promise => promise.then(answer => ({ resolved: answer }), error => ({ code: error?.code, message: error?.message }))
const pastTheApprovalGate = code => code === undefined || !/^APPROVAL_/.test(code)

try {
  const servicesRoot = path.join(scratchRoot, 'services')
  const workspace = path.join(scratchRoot, 'workspace')
  /* Built by the product's own builder and checked by its own validator -- a
     hand-written `{tier}` is refused SETUP_MACHINE_RECORD_INVALID. It decides
     the CEILING only. */
  const record = machineRecord.buildMachineRecord({
    tier: 'standard', installRoot: payload, servicesRoot,
    nodePath: process.execPath, workspaceRoots: [workspace],
  })
  machineRecord.validateMachineRecord(record)
  writeFileSync(machineRecord.machineRecordPath(servicesRoot), JSON.stringify(record), 'utf8')

  const scoped = { ...machineRecord, resolveServicesRoot: () => servicesRoot }
  let permissionSession
  try {
    permissionSession = sessions.recordedInstallSession({ machineRecord: scoped })
  } catch (error) {
    refuse(`the real recordedInstallSession refused the scratch record (${error?.code || error?.message})`)
  }
  process.stdout.write(`vault-removal-end-to-end-qa: ceiling ${JSON.stringify(permissionSession)}\n`)
  process.stdout.write(`  vault this run can reach: ${fenced.vaultFile}\n`)
  check(permissionSession !== undefined, 'the real recordedInstallSession answered a ceiling from a real record')

  /* THE MINT AND THE CONSUME MUST BE THE SAME STORE. `approvals.consume`
     refuses injected dependencies and always reads the process-wide
     `getStateStore()`; a grant minted anywhere else is APPROVAL_NOT_FOUND to
     the dispatch. shell/main.cjs mints through that singleton, so this does
     too -- fenced above to the scratch database. */
  const store = stateStore.getStateStore()

  /* SEED THE RECORD THE REMOVAL IS ABOUT, so COMPLETED can mean something.
   *
   * Without this the carried dispatch acts on an absent key and ends
   * SECRET_NOT_CONFIGURED, so the COMPLETED branch could never fire -- and that
   * branch was `check(true, ...)`, a marker that cannot fail either. A check
   * that can neither fire nor fail is the defect this lane keeps re-finding,
   * and the driver whose whole purpose is proving the removal is the worst
   * place to ship one.
   *
   * The value is an obviously synthetic placeholder and it goes into the vault
   * inside this run's own scratch root -- the fence resolved and cleared that
   * exact path before anything here ran. */
  const seeded = seedSyntheticRecord(fenced.vaultFile)
  process.stdout.write(`  seeded ${OWNED_KEY} into the fenced vault: ${seeded ? 'yes' : `no (${seededWhy})`}\n`)

  const bare = await codeOf(registry.executeTool('system.credential_remove',
    { vaultKey: OWNED_KEY, reason: REASON }, { permissionSession }))
  process.stdout.write(`  dispatch with no token -> ${bare.code ?? 'resolved'}\n`)
  const gated = bare.code === 'APPROVAL_REQUIRED'
  check(bare.code !== 'PERMISSION_SESSION_REQUIRED', 'the dispatch is no longer refused for want of a stated ceiling')
  if (gated) {
    process.stdout.write(`    "${bare.message}"\n`)
    process.stdout.write('    ^ the second prompt T266 removes: the owner already approved at #/approvals\n')
  } else {
    process.stdout.write('    note: approvals are off for this tool in this environment, so there is no second prompt here\n')
  }

  const { TOOL, createOwnerApprovedRemover } = require_(path.join(ROOT, 'shell', 'vault-credential-approval.cjs'))
  const mints = []
  const audits = []
  const remover = createOwnerApprovedRemover({
    executeTool: (name, args, context) => registry.executeTool(name, args, context),
    createGrant: grant => { mints.push(grant); return store.createApprovalGrant(grant) },
    inputHash: approvals.actionInputHash,
    tokenHash: approvals.tokenHash,
    permissionSession,
    onGrant: entry => { audits.push(entry); process.stdout.write(`  minted for owner prompt ${entry.ownerPromptId}, key ${entry.vaultKey}\n`) },
  })
  const carried = await codeOf(remover({ vaultKey: OWNED_KEY, reason: REASON, ownerPromptId: OWNER_PROMPT }))
  process.stdout.write(`  dispatch with the carried grant -> ${carried.code ?? 'resolved'}\n`)
  if (carried.code) process.stdout.write(`    "${carried.message}"\n`)

  check(pastTheApprovalGate(carried.code),
    `the carried grant got past every approval check, so the owner meets ONE prompt and not two (${carried.code ?? 'resolved'})`)
  check(mints.length === (gated ? 1 : 0), `${gated ? 'exactly one grant was' : 'no grant was'} minted for one owner decision (${mints.length})`)
  check(audits.length === mints.length, 'every minted grant is recorded against the decision that authorised it')

  /* DID THE RECORD GO. Not "did the call return" -- the vault is read again and
     the name must be absent from it. That is the only form of this check that
     can fail, and it is why the seed above exists. */
  if (carried.resolved) {
    process.stdout.write(`  COMPLETED: ${JSON.stringify(carried.resolved).slice(0, 200)}\n`)
    check(seeded, 'the record was on file before the removal, so COMPLETED is about something')
    const after = listFencedVaultNames(fenced.vaultFile)
    if (after === null) {
      check(false, 'the fenced vault could not be read after the removal, so whether the record went is unknown')
    } else {
      process.stdout.write(`  the fenced vault now holds: ${JSON.stringify(after)}\n`)
      check(!after.includes(OWNED_KEY), `${OWNED_KEY} is GONE from the vault, not merely reported removed`)
    }
  } else {
    process.stdout.write(`  the removal did not complete: ${carried.code}. That is reported, not worked around.\n`)
    if (seeded) {
      const after = listFencedVaultNames(fenced.vaultFile)
      if (after !== null) {
        check(after.includes(OWNED_KEY),
          `the removal failed and the record is still on file, which is the honest pair (${JSON.stringify(after)})`)
      }
    }
  }

  /* BOUND TO ONE RECORD, SPENDABLE ONCE. Executed. */
  const token = randomBytes(32).toString('base64url')
  store.createApprovalGrant({
    action: TOOL,
    inputHash: approvals.actionInputHash(TOOL, { vaultKey: OWNED_KEY, reason: REASON }),
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
  const crossName = offer(TOOL, { vaultKey: OTHER_KEY, reason: REASON })
  check(crossName === 'APPROVAL_BINDING_MISMATCH', `a token approved for ${OWNED_KEY} is refused for ${OTHER_KEY} (${crossName})`)
  const crossAction = offer('system.credential_request', { vaultKey: OWNED_KEY, reason: REASON })
  check(crossAction === 'APPROVAL_BINDING_MISMATCH' || crossAction === 'APPROVAL_NOT_FOUND',
    `a removal approval is refused for another tool (${crossAction})`)
  const first = offer(TOOL, { vaultKey: OWNED_KEY, reason: REASON })
  check(first === 'consumed', `the token is good once for its own record (${first}) -- so the refusals are binding, not breakage`)
  const replay = offer(TOOL, { vaultKey: OWNED_KEY, reason: REASON })
  check(replay === 'APPROVAL_ALREADY_USED', `the replay is refused (${replay})`)

  if (mints.length === 1) {
    let spent
    try {
      spent = store.consumeApprovalGrant({
        action: TOOL,
        inputHash: approvals.actionInputHash(TOOL, { vaultKey: OWNED_KEY, reason: REASON }),
        tokenHash: mints[0].tokenHash,
      }).status
    } catch (error) { spent = error?.code }
    check(spent === 'APPROVAL_ALREADY_USED', `the grant the real dispatch consumed cannot be spent again (${spent})`)
  }
} finally {
  try { stateStore.closeStateStore?.() } catch { /* the parent removes the scratch root */ }
}

if (failures > 0) {
  process.stdout.write(`vault-removal-end-to-end-qa: ${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write('vault-removal-end-to-end-qa: one owner decision, carried through the real dispatch, spendable once.\n')
}
