/* DOES THE FENCE TOUCH THE DISK BEFORE IT JUDGES IT.
 *
 * WHY THIS EXISTS AS A SEPARATE PROOF. The end-to-end driver's four fence
 * proofs all exercise REFUSAL PATHS -- point it at the live installation, at
 * somebody else's scratch, at nothing -- and every one of them passed both
 * before and after two real defects, because none of them can see WHICH
 * RESOLVER IS INVOKED. `stateRoot()` and `resolveStateRoot({environment}).root`
 * return the identical string; the first calls `fs.mkdirSync` and the second
 * does not. A proof set that cannot tell a pure resolver from a mkdir-ing one
 * is not proving the property the fence claims.
 *
 * So this hooks the filesystem and the child-process module, runs
 * `assertScratchFence` against a scratch root whose paths DO NOT EXIST, and
 * fails if anything was created, opened for writing, or spawned. The fence is
 * supposed to be a question, and a question does not leave marks.
 *
 * MEASURED BEFORE THIS EXISTED, which is why it does: the fence's own first
 * resolution called `stateRoot()`, which created the state-root directory
 * before judging it -- and resolving the audit ledger by requiring
 * `audit-store.js` would have created it a second time, because that module's
 * `DEFAULT_AUDIT_DB` is `rootPath('state','audit.sqlite3')` evaluated at load.
 *
 * It also checks the fence's COVERAGE against the product's own enumeration:
 * every `TOOLSENABLED_*` path override `shell/capability-path-environment.cjs`
 * names must either be redirected by `fencedEnvironment` or be swept by the
 * derived pass. A hand-written fence list is wrong the day the product adds a
 * variable, and this one was wrong the day it was written.
 *
 * REFUSES BY NAME rather than passing quietly when it cannot measure.
 *
 * Usage:
 *   node tools/vault-fence-purity-qa.mjs [--release <win-unpacked>]
 * Without --release, MC_TEST_CAPABILITY_PAYLOAD names the payload instead.
 */

import fs from 'node:fs'
import childProcess from 'node:child_process'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { qaCapabilityPayload } from './lib/qa-capability-payload.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')

function refuse(reason) {
  process.stdout.write(`vault-fence-purity-qa: NOT MEASURED -- ${reason}\n`)
  process.exit(3)
}

const payload = qaCapabilityPayload()
if (!payload) refuse('neither --release nor MC_TEST_CAPABILITY_PAYLOAD names a payload, so the fence resolvers could not be reached.')

/* THE FENCE MODULE, NOT THE DRIVER, AND THIS LINE IS THE FIX FOR A REAL
 * INCIDENT. This proof first imported tools/vault-removal-end-to-end-qa.mjs to
 * reach the fence, and `await import()` RAN THAT SCRIPT -- a full seeded
 * removal, under an explicit instruction not to run it. It ran fenced and
 * reached no live artefact, and this proof's own checks never executed at all
 * because the driver called process.exit first. The fence now lives in a module
 * with no top level, so importing it cannot run anything. A static import, so
 * it is visible in the file's import list rather than buried in a call. */
import {
  accountIdentityNames,
  ScratchFenceRefusal,
  assertRefusalPrecedesResolution,
  assertScratchFence,
  fenceNameAuthorities,
  fenceRequiredNames,
  fencedEnvironment,
} from './lib/vault-scratch-fence.mjs'

let failures = 0
function check(condition, sentence) {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'} ${sentence}\n`)
  if (!condition) failures += 1
}

/* EVERY WAY THIS COULD LEAVE A MARK, hooked. Reads are allowed -- the fence has
   to read the environment and require two modules; creating, writing and
   spawning are not. */
const WRITERS = ['mkdirSync', 'mkdir', 'writeFileSync', 'writeFile', 'appendFileSync', 'openSync', 'rmSync', 'renameSync', 'copyFileSync']
const SPAWNERS = ['spawnSync', 'spawn', 'execSync', 'execFileSync', 'execFile', 'exec']

function withHooks(run) {
  const observed = []
  const originalFs = new Map()
  const originalCp = new Map()
  for (const name of WRITERS) {
    if (typeof fs[name] !== 'function') continue
    originalFs.set(name, fs[name])
    fs[name] = (...args) => {
      /* openSync for reading is not a write; only record the modes that create
         or truncate. Everything else is recorded unconditionally. */
      if (name === 'openSync') {
        const flags = String(args[1] ?? 'r')
        if (!/[waxc+]/.test(flags)) return originalFs.get(name)(...args)
      }
      observed.push(`fs.${name}(${String(args[0])})`)
      return originalFs.get(name)(...args)
    }
  }
  for (const name of SPAWNERS) {
    if (typeof childProcess[name] !== 'function') continue
    originalCp.set(name, childProcess[name])
    childProcess[name] = (...args) => {
      observed.push(`child_process.${name}(${String(args[0])})`)
      return originalCp.get(name)(...args)
    }
  }
  try {
    return { observed, outcome: run() }
  } catch (error) {
    return { observed, error }
  } finally {
    for (const [name, original] of originalFs) fs[name] = original
    for (const [name, original] of originalCp) childProcess[name] = original
  }
}

/* A scratch root that EXISTS, with every path inside it that does NOT. If the
   fence creates anything, it creates it here and the hooks see it. */
const scratch = mkdtempSync(path.join(process.env.TEMP || process.env.TMP || '.', 'w87-purity-'))
try {
  const { environment } = fencedEnvironment(scratch)
  /* Deliberately NOT creating the directories fencedEnvironment names. The
     fence must answer over paths that do not exist yet. */
  process.stdout.write(`vault-fence-purity-qa: scratch ${scratch}, none of its subdirectories created\n`)

  const { observed, outcome, error } = withHooks(() => assertScratchFence({
    payload, scratchRoot: scratch, environment,
  }))

  if (error) {
    process.stdout.write(`  the fence refused: ${error?.message?.split('\n')[0]}\n`)
    check(false, 'the fence cleared a scratch environment it built itself')
  } else {
    check(true, `the fence cleared and returned ${Object.keys(outcome).length} labelled path(s)`)
  }

  /* THE PROPERTY THE OTHER FOUR PROOFS CANNOT SEE. */
  if (observed.length > 0) for (const call of observed) process.stdout.write(`    observed: ${call}\n`)
  check(observed.length === 0, `the fence made no write and spawned nothing while judging (${observed.length} observed)`)

  /* And nothing appeared on disk, checked independently of the hooks in case a
     path reached the filesystem some way they do not cover. */
  const created = ['state-root', 'LocalAppData', 'RoamingAppData', 'logs', 'services', 'workspace']
    .filter(name => fs.existsSync(path.join(scratch, name)))
  if (created.length > 0) process.stdout.write(`    created: ${JSON.stringify(created)}\n`)
  check(created.length === 0, `the fence created no directory under the scratch root (${created.length} found)`)

  /* PER-NAME ABSENCE REFUSAL, across the whole set. Rule 1: an unset name is
     the dangerous state. One run per name, each with exactly that name removed,
     because a check that only tries an empty environment proves the loop runs
     once and nothing about the thirteenth name. */
  const REQUIRED_NAMES = fenceRequiredNames()
  const redirected = new Set(REQUIRED_NAMES)
  let absenceRefusals = 0
  for (const name of REQUIRED_NAMES) {
    const withoutOne = { ...environment }
    delete withoutOne[name]
    let refusedFor = null
    try {
      assertScratchFence({ payload, scratchRoot: scratch, environment: withoutOne })
    } catch (error) {
      if (error instanceof ScratchFenceRefusal && error.message.startsWith(`${name} is not set`)) refusedFor = name
      else refusedFor = `WRONG REFUSAL: ${error?.message?.split('\n')[0]}`
    }
    if (refusedFor === name) absenceRefusals += 1
    else process.stdout.write(`    ${name}: ${refusedFor === null ? 'CLEARED WITH IT UNSET' : refusedFor}\n`)
  }
  check(absenceRefusals === REQUIRED_NAMES.length,
    `every one of the ${REQUIRED_NAMES.length} names is refused BY NAME when unset (${absenceRefusals})`)

  /* AND WHEN EMPTY. An empty string is neither absent nor a path: it slips past
     a presence test that only asks whether the key exists, and past a path test
     that only asks whether it points live. Controller named this and it was a
     real addition -- both rules as first written would have let it through. */
  let emptyRefusals = 0
  for (const name of REQUIRED_NAMES) {
    let refused = false
    try {
      assertScratchFence({ payload, scratchRoot: scratch, environment: { ...environment, [name]: '   ' } })
    } catch (error) {
      refused = error instanceof ScratchFenceRefusal && new RegExp(`^${name} is (empty|not set)`).test(error.message)
    }
    if (refused) emptyRefusals += 1
    else process.stdout.write(`    ${name}: NOT REFUSED WHEN EMPTY\n`)
  }
  check(emptyRefusals === REQUIRED_NAMES.length,
    `every one of the ${REQUIRED_NAMES.length} names is refused when EMPTY, not only when absent (${emptyRefusals})`)

  /* THE ORDERING, ASSERTED RATHER THAN READ FROM THE SOURCE.
     `perUserStateRoot`'s os.homedir default is the last ambient input in the
     chain and is reachable only when STATE_ROOT is unset; the by-name refusal
     is what prevents it. The fence is handed a resolver loader that THROWS if
     it is ever called, so if the refusal did not come first the tripwire's
     error would surface instead of the named refusal. An ordering read from
     source is the evidence class that missed `vaultPath()`. */
  let orderingProof = null
  try {
    orderingProof = assertRefusalPrecedesResolution({ payload, scratchRoot: scratch, environment })
  } catch (error) {
    process.stdout.write(`    ${error?.message}\n`)
  }
  check(orderingProof !== null,
    "the STATE_ROOT refusal precedes path resolution, so perUserStateRoot's os.homedir default is unreachable")

  /* TIER (ii): A PRODUCT OVERRIDE SET OUTSIDE THE SCRATCH ROOT IS REFUSED.
   *
   * The case that moved the rule, and Worker 89's own example:
   * TOOLSENABLED_RESEARCH_DB pointed at C:\elsewhere\research.sqlite3 was
   * ACCEPTED under a not-live-only rule -- and providers/web.js opens exactly
   * that path as its sqlite evidence database, so it was accepted and then
   * WRITTEN THROUGH. Not-live is the wrong rule for a name the product writes.
   *
   * Both halves are checked, because the tier is two claims: absent is fine
   * (its default derives from the fenced state root), set-outside is refused. */
  const tierTwo = fenceNameAuthorities().byCategory.get('capability path overrides')
    .filter(name => !REQUIRED_NAMES.includes(name))
  process.stdout.write(`    tier (ii) covers ${tierTwo.length} product override(s) beyond the owned set\n`)
  for (const name of ['TOOLSENABLED_RESEARCH_DB', 'TOOLSENABLED_SEARCH_DB', 'TOOLSENABLED_SETTINGS_PATH']) {
    if (!tierTwo.includes(name)) { check(false, `${name} is not in tier (ii), so this case measures nothing`); continue }

    /* absent -- must CLEAR, because the default lands inside the fence */
    let clearedWhenAbsent = false
    try { assertScratchFence({ payload, scratchRoot: scratch, environment }); clearedWhenAbsent = true } catch { /* below */ }
    check(clearedWhenAbsent, `${name} ABSENT clears -- its default derives from the fenced state root`)

    /* set outside the scratch, and NOT live -- must still be REFUSED */
    const elsewhere = { ...environment, [name]: path.join('C:', 'elsewhere', 'research.sqlite3') }
    let refusedOutside = false
    try {
      assertScratchFence({ payload, scratchRoot: scratch, environment: elsewhere })
    } catch (error) {
      refusedOutside = error instanceof ScratchFenceRefusal && /outside this run's scratch root/.test(error.message)
      if (!refusedOutside) process.stdout.write(`    ${name}: wrong refusal -- ${error?.message?.split('\n')[0]}\n`)
    }
    check(refusedOutside, `${name} SET outside the scratch root is REFUSED -- the product writes through it`)
  }

  /* AND NO PATH IS REPORTED TWICE. `cleared` is keyed by label, so the semantic
     entries and the by-name sweep both covered STATE_ROOT, VAULT_PATH and the
     ledger until the consumed names were skipped. A duplicate in the output is
     how a reader loses track of what was actually judged. */
  const clearedOnce = withHooks(() => assertScratchFence({ payload, scratchRoot: scratch, environment })).outcome
  const paths = Object.values(clearedOnce)
  const labels = Object.keys(clearedOnce)
  const duplicatedNames = labels.filter(label => /^TOOLSENABLED_(STATE_ROOT|VAULT_PATH|AUDIT_DB)$/.test(label))
  if (duplicatedNames.length > 0) process.stdout.write(`    also keyed by name: ${duplicatedNames.join(', ')}\n`)
  check(duplicatedNames.length === 0,
    `no path is cleared twice -- ${labels.length} labels over ${new Set(paths).size} distinct path(s)`)

  /* USERPROFILE AND HOME ARE CONTAINED, NOT EXEMPT -- and this is the check
   * that would have caught me.
   *
   * I moved the pair out of containment into the account-identity tier on the
   * strength of a sentence I had written and Manager had carried upward: "the
   * payload reads them as homeDir in three files and writes through neither."
   * Both halves were wrong. Seven files read them, and
   * multi-account/registry-write.js's destroyCredential resolves a relative
   * account directory against that homeDir and calls unlinkSync on the
   * credential -- a write-and-delete path. The isolation guard downstream is
   * not an absence of write-through.
   *
   * So: pointed at the account they must be REFUSED as outside the scratch, and
   * that is the opposite of what the earlier version of this proof asserted.
   * The proof agreed with the code because both came from the same wrong
   * sentence, which is why the sentence was worth writing down and worth
   * correcting. */
  for (const name of ['USERPROFILE', 'HOME']) {
    check(REQUIRED_NAMES.includes(name), `${name} is in the OWNED tier -- the product writes and deletes through it`)
    check(!accountIdentityNames().includes(name), `${name} is NOT in the account-identity tier`)
    const account = { ...environment, [name]: path.join('C:', 'Users', 'someone') }
    let refusedOutside = false
    try {
      assertScratchFence({ payload, scratchRoot: scratch, environment: account })
    } catch (error) {
      refusedOutside = error instanceof ScratchFenceRefusal && /outside this run's scratch root/.test(error.message)
      if (!refusedOutside) process.stdout.write(`    ${name}: wrong refusal -- ${error?.message?.split('\n')[0]}\n`)
    }
    check(refusedOutside, `${name} pointed at the account is REFUSED as outside the scratch root`)
  }

  /* THE PER-AUTHORITY FLOORS, EACH REFUSING ON ITS OWN.
     A single floor over the union cannot say WHICH source went quiet -- the
     profile authority returning zero would still leave the union above twenty.
     So each is starved in turn, with the others intact, and the refusal must
     name that authority's own category. An authority that half-loads yields a
     SHORT LIST rather than an error, which is the whole reason a floor exists. */
  const realRequire = createRequire(import.meta.url)
  const stubbedAuthorities = (overrides) => (modulePath) => {
    const normalised = String(modulePath).replace(/\\/g, '/')
    for (const [suffix, value] of Object.entries(overrides)) {
      if (normalised.endsWith(suffix)) return value
    }
    return realRequire(path.join(ROOT, normalised.split('/').slice(-2).join(path.sep)))
  }
  const floorCases = [
    ['capability path overrides', { 'shell/capability-path-environment.cjs': { CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES: ['A', 'B'] } }],
    ['OS profile roots', { 'shell/install-profile-guard.cjs': { STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES: ['APPDATA'], PROVIDER_HOME_ENVIRONMENT_NAMES: ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_DIR'] } }],
    ['provider account homes', { 'shell/install-profile-guard.cjs': { STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES: ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME'], PROVIDER_HOME_ENVIRONMENT_NAMES: ['CODEX_HOME'] } }],
  ]
  for (const [category, overrides] of floorCases) {
    let named = false
    try {
      fenceNameAuthorities({ repoRoot: ROOT, load: stubbedAuthorities(overrides) })
    } catch (error) {
      named = error instanceof ScratchFenceRefusal && error.message.includes(category) && /under the floor/.test(error.message)
      if (!named) process.stdout.write(`    ${category}: ${error?.message?.slice(0, 110)}\n`)
    }
    check(named, `a short read of the ${category} authority is refused, naming that authority`)
  }
  /* And an authority that cannot be read at all is refused too, not treated as
     an empty category. */
  let unreadableRefused = false
  try {
    fenceNameAuthorities({ repoRoot: ROOT, load: () => { throw Object.assign(new Error('gone'), { code: 'MODULE_NOT_FOUND' }) } })
  } catch (error) {
    unreadableRefused = error instanceof ScratchFenceRefusal && /could not be read/.test(error.message)
  }
  check(unreadableRefused, 'an authority that cannot be read is refused, not read as an empty category')

  /* THE READ-ONLY PAIR TAKES THE WEAKER RULE, and that is the membership test
     applied rather than an exception to it: USERPROFILE and HOME are READ as
     homeDir and written through by neither, so containment is not applicable
     while not-live still is. Pointed at the account they clear; pointed at the
     installation they refuse. */
  for (const name of accountIdentityNames()) {
    const account = { ...environment, [name]: path.join('C:', 'Users', 'someone') }
    let clearedAtAccount = false
    try { assertScratchFence({ payload, scratchRoot: scratch, environment: account }); clearedAtAccount = true } catch { /* below */ }
    check(clearedAtAccount, `${name} pointing at the account CLEARS -- it is read, not written through`)

    const liveHome = { ...environment, [name]: String.raw`C:\Users\x\Desktop\joshs profile\ToolsEnabled-Live\services` }
    let refusedAtLive = false
    try {
      assertScratchFence({ payload, scratchRoot: scratch, environment: liveHome })
    } catch (error) {
      refusedAtLive = error instanceof ScratchFenceRefusal && /INSIDE THE LIVE INSTALLATION/.test(error.message)
    }
    check(refusedAtLive, `${name} pointing into the installation is still REFUSED`)
  }

  /* THE PROVIDER CATEGORY, AGAINST THIS SHELL'S REAL INHERITED ENVIRONMENT.
   *
   * One category that exercises BOTH rules at once, which is why it is worth a
   * check of its own rather than being folded into the loops above. Measured in
   * every agent shell on this machine:
   *
   *   CLAUDE_CONFIG_DIR  SET, and pointing at the owner's signed-in account
   *                      home UNDER the live installation  -> rule 2, by value
   *   CODEX_HOME         UNSET                              -> rule 1, by absence
   *   GEMINI_DIR         UNSET                              -> rule 1, by absence
   *
   * So this takes `process.env` exactly as inherited -- no scratch values, no
   * construction -- and shows the fence refuses it. The absence half is the one
   * easy to under-weight: an absent provider home means the provider layer
   * picks its own default, and that default derives from the installation, so
   * absence is the installation by another route. */
  const inherited = { ...process.env }
  const providerState = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR'].map(name => {
    const value = inherited[name]
    const set = typeof value === 'string' && value.trim().length > 0
    return `${name}=${set ? (/toolsenabled-live/.test(value.toLowerCase()) ? 'SET and LIVE' : 'set') : 'UNSET'}`
  })
  process.stdout.write(`    this shell inherits: ${providerState.join(', ')}\n`)
  let inheritedRefusal = null
  try {
    assertScratchFence({ payload, scratchRoot: scratch, environment: inherited })
  } catch (error) {
    inheritedRefusal = error instanceof ScratchFenceRefusal ? error.message.split('\n')[0] : `NOT A FENCE REFUSAL: ${error?.message}`
  }
  process.stdout.write(`    refused with: ${inheritedRefusal ?? 'NOTHING -- it cleared'}\n`)
  check(inheritedRefusal !== null, "the shell's own inherited environment is refused, not cleared")

  /* And each provider name individually, so the category is covered per name
     rather than by whichever one the loop happened to reach first. */
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) {
    const one = { ...environment, [name]: inherited[name] }
    if (one[name] === undefined) delete one[name]
    let refusal = null
    try {
      assertScratchFence({ payload, scratchRoot: scratch, environment: one })
    } catch (error) {
      refusal = error instanceof ScratchFenceRefusal ? error.message : null
    }
    const byAbsence = refusal !== null && refusal.startsWith(`${name} is not set`)
    const byValue = refusal !== null && /INSIDE THE LIVE INSTALLATION/.test(refusal)
    check(byAbsence || byValue,
      `${name} as this shell has it is refused (${byValue ? 'by value, it points live' : byAbsence ? 'by absence' : 'NOT REFUSED'})`)
  }

  /* THE MATCHER, IN FIVE SPELLINGS. Case-fold plus bare substring, not
     normalise-then-compare and not segment-exact. The last one is the case the
     earlier segment-exact form ACCEPTED: `toolsenabled-live-backup` is not
     EQUAL to `toolsenabled-live`, so an adjacent directory got through. */
  const live = String.raw`C:\Users\x\Desktop\joshs profile\ToolsEnabled-Live\capability\vault\secrets.json`
  const spellings = [
    ['as-is mixed case', live],
    ['lower', live.toLowerCase()],
    ['upper', live.toUpperCase()],
    ['forward slash', live.replace(/\\/g, '/')],
    ['msys /c/', live.replace(/^C:\\/, '/c/').replace(/\\/g, '/')],
    ['doubled separators', live.replace(/\\/g, '\\\\')],
    ['trailing separator', `${live}\\`],
    ['adjacent name ToolsEnabled-Live-backup', live.replace('ToolsEnabled-Live', 'ToolsEnabled-Live-backup')],
  ]
  for (const [label, candidate] of spellings) {
    let refused = false
    try {
      assertScratchFence({
        payload, scratchRoot: scratch,
        environment: { ...environment, TOOLSENABLED_VAULT_PATH: candidate },
      })
    } catch (error) {
      refused = error instanceof ScratchFenceRefusal && /INSIDE THE LIVE INSTALLATION/.test(error.message)
      if (!refused) process.stdout.write(`    ${label}: refused for the wrong reason -- ${error?.message?.split('\n')[0]}\n`)
    }
    check(refused, `the ${label} spelling of a live path is refused as live`)
  }

  /* COVERAGE, against the product's own enumeration rather than against my
     memory of it -- and from BOTH modules, because either alone has a gap. */
  let enumerated
  try { enumerated = fenceNameAuthorities().names } catch (error_) { enumerated = null; process.stdout.write(`    ${error_?.message}\n`) }
  if (!enumerated) {
    check(false, 'the product path-variable enumeration could not be read, so coverage is unknown')
  } else {
    const swept = enumerated.filter(name => !redirected.has(name))
    process.stdout.write(`    the product enumerates ${enumerated.length} path variable(s) across two modules; `
      + `${enumerated.length - swept.length} are redirected and ${swept.length} are held to the live rule when set\n`)
    check(enumerated.every(name => redirected.has(name) || swept.includes(name)),
      'every path variable the product enumerates is either redirected or held to the live rule')
    /* The four a hand-written list missed, and the three Worker 85 found after
       everything else was fenced. Named so a regression is legible rather than
       a count going down by one. */
    for (const name of ['TOOLSENABLED_AUDIT_DB', 'TOOLSENABLED_AUDIT_JSONL_PATH',
      'TOOLSENABLED_AUDIT_TEXT_PATH', 'TOOLSENABLED_AUDIT_EMERGENCY_PATH',
      'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_DIR',
      'LOCALAPPDATA', 'APPDATA', 'TOOLSENABLED_STATE_PATH']) {
      check(redirected.has(name), `${name} is redirected, not merely swept`)
    }
    /* The bare audit forms are read nowhere in the product; a fence naming
       them would fence nothing. Asserted so the shorthand cannot creep back. */
    for (const dead of ['AUDIT_JSONL', 'AUDIT_TEXT', 'AUDIT_EMERGENCY']) {
      check(!redirected.has(dead), `${dead} is NOT in the set -- the bare form is read nowhere in the product`)
    }
  }
} finally {
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* reported below */ }
  process.stdout.write(fs.existsSync(scratch)
    ? `  COULD NOT REMOVE the scratch root: ${scratch}\n`
    : '  removed the scratch root\n')
}

if (failures > 0) {
  process.stdout.write(`vault-fence-purity-qa: ${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write('vault-fence-purity-qa: the fence answers without touching, and covers what the product enumerates.\n')
