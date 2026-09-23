/* MAY A RUN TOUCH THE DISK IT IS ABOUT TO TOUCH.
 *
 * THE ONE DECISION, IN A MODULE WITH NO TOP LEVEL. Nothing is required at load;
 * `createRequire` is made and used lazily inside the calls. Importing this
 * executes nothing, which is not politeness -- when the fence was exported FROM
 * a driver, a proof imported the driver to call it and `await import()` ran a
 * full seeded removal that was under an instruction not to run. The cause is
 * gone by construction rather than by care.
 *
 * WHY IT IS NEEDED. Every agent shell on this machine inherits, from the live
 * application:
 *
 *   TOOLSENABLED_STATE_ROOT  = <live installation>\capability
 *   TOOLSENABLED_VAULT_PATH  = <live installation>\capability\vault\secrets.json
 *   CLAUDE_CONFIG_DIR        = <live installation>\services\account-homes\claude\<account>
 *
 * and `resolveVaultLocation` honours VAULT_PATH FIRST. A run that redirected
 * only the state-store path left the state root, the protected audit head, the
 * signing key, THE VAULT ITSELF and the owner's signed-in provider account
 * live, and wrote signed rows into the owner's real ledger.
 *
 * ============ THE FOUR CATEGORIES, NAMED ============
 *
 * Every gap this lane found was a CATEGORY nobody had named, not a name someone
 * forgot: the audit sinks missing from a hand list, the profile roots missing
 * from a derived list, the provider homes missing from both. A flat list reads
 * as complete and cannot say complete OF WHAT. So:
 *
 *   1  CAPABILITY PATH OVERRIDES  every state file and directory the capability
 *      layer lets an operator move
 *   2  AUDIT SINKS               the ledger and its three log files. A subset of
 *      (1) in the product's enumeration, named separately here because they are
 *      the category a hand list missed
 *   3  OS PROFILE ROOTS          APPDATA (roaming -- what Electron userData
 *      resolves through), LOCALAPPDATA (local -- the services root), USERPROFILE
 *      and HOME
 *   4  PROVIDER ACCOUNT HOMES    CODEX_HOME, CLAUDE_CONFIG_DIR, GEMINI_DIR
 *
 * If a fifth category exists, it is a category — look for the authority that
 * enumerates it, not for a name to append.
 *
 * ============ THE THREE RULES ============
 *
 * A  ABSENT OR EMPTY IS THE DANGEROUS STATE, NOT THE SAFE ONE, for any name
 *    whose default does NOT derive from something this fence has already
 *    fenced. The product then picks its own default and that default comes from
 *    the profile or the OS -- so absence is the installation by another route.
 *    An EMPTY STRING is neither absent nor a path and would slip past a naive
 *    presence test, so it is treated as absence explicitly.
 *
 * B  NOT LIVE. Case-fold plus BARE SUBSTRING on the whole path -- never
 *    normalise-then-compare, which has failed open twice in this lane through
 *    sed and through a quoted heredoc. An earlier version here split on [\\/]+
 *    and compared segments EXACTLY, which is narrower than it looks: a path
 *    under `...\ToolsEnabled-Live-backup\` yields the segment
 *    `toolsenabled-live-backup`, not equal to `toolsenabled-live`, so it was
 *    ACCEPTED. A scratch directory literally named ToolsEnabled-Live is now
 *    refused too; for a fence that is the correct direction to be wrong in.
 *
 * C  CONTAINED -- inside the scratch root this run created.
 *
 * ============ WHICH RULES APPLY TO WHAT, AND THE TEST ============
 *
 * THE MEMBERSHIP TEST, which is not derivable from the code and is the thing a
 * future reader needs: DOES THE PRODUCT WRITE THROUGH THIS VARIABLE? If yes it
 * needs CONTAINMENT -- anything the run writes through must land somewhere
 * disposable. If it is only READ, NOT LIVE is sufficient, because a path the
 * run merely reads may legitimately point at the account. Being in the
 * product's enumeration is NOT the test; the enumeration says nothing about
 * which of the two a name is.
 *
 * MEASURED, because the question was open: at least one swept override IS a
 * write target -- `TOOLSENABLED_SEARCH_DB` feeds `DB_PATH` in src/lib/search.js
 * straight into a sqlite database. The same shape covers SETTINGS_PATH,
 * OWNER_LEDGER_FILE, AGENT_MAILBOX_DIR, RESEARCH_DB and TREE_DIRECTORY_FILE. I
 * A survey found write-bearing readers for 22 of the 26 swept names --
 * RESEARCH_DB, SEARCH_DB, TREE_DIRECTORY_FILE (writeFileSync + renameSync),
 * AGENT_MAILBOX_DIR, PRESENCE_FILE, USEFUL_PROGRESS_DIR, LAUNCH_DIR,
 * PROVIDER_STATE_FILE, SETTINGS_PATH, WORKER_RUNTIME_DIR,
 * SCHEDULER_LEGACY_PATH, KILLSWITCH_PATH and both OVERNIGHT_ADVISORY dirs.
 * DECLARED BOUND: that is a file-level grep, not per-variable data flow, so 22
 * is an upper bound on certainty rather than a count of proven writes. Rather
 * than guess per name, containment applies to ALL of them when set, which is
 * safe whichever way the unmeasured four fall.
 *
 * The exemption is tier (iii) and it is DERIVED, not a named pair: it is
 * whatever install-profile-guard enumerates that the owned tier does not claim.
 * Today that is USERPROFILE, HOME, NODE_OPTIONS and NODE_PATH.
 *
 * THE THREE TIERS, and the split between (ii) and (iii) is BY AUTHORITY, which
 * is what makes it derivable rather than remembered:
 *
 *   (i)   OWNED -- whatever `fencedEnvironment` re-points. Must be SET, must be
 *         non-empty, must be CONTAINED. Derived from that function, because a
 *         run owns exactly what it re-points and any other definition can
 *         disagree with it.
 *   (ii)  PRODUCT OVERRIDES -- capability-path-environment's remaining names.
 *         Unset is FINE; if SET, CONTAINED.
 *   (iii) ACCOUNT IDENTITY -- install-profile-guard's remaining names.
 *         Not-live only.
 *
 * WHY ABSENCE IS TOLERATED IN TIER (ii) AND NOT TIER (i), which
 * is the weak form of rule A and is right HERE for a reason a reader must not
 * copy blindly: those overrides' product defaults derive from the STATE ROOT,
 * and the state root is fenced by name first -- so an absent one lands inside
 * the fence anyway. The required names are required precisely because their
 * defaults do NOT: the profile roots and the provider homes derive from the
 * profile, and CLAUDE_CONFIG_DIR most of all.
 *
 * ============ THE LOAD ORDER IS PART OF THE FENCE ============
 *
 * Only `node:path` and modules whose require AND whose calls are both pure are
 * touched. Three traps found in one file: `getStateStore()` OPENS the database,
 * `stateRoot()` calls fs.mkdirSync, and requiring `audit-store.js` creates the
 * state-root directory because its DEFAULT_AUDIT_DB is rootPath('state',...)
 * evaluated at load. A fourth is ordering rather than purity:
 * `perUserStateRoot`'s `os.homedir` default is the last ambient input in the
 * chain and is reachable only when STATE_ROOT is unset -- so the by-name
 * refusal for STATE_ROOT is what prevents it, and that refusal runs before any
 * resolver is called. `assertRefusalPrecedesResolution` below is that ordering
 * asserted rather than read from the source, because an ordering read from
 * source is the evidence class that missed `vaultPath()`.
 *
 * ============ THE SET IS THE CALLER'S ============
 *
 * When a shared helper becomes the backend, `assertScratchFence`'s body becomes
 * a call to it -- but the SET is passed in. Measured at the assembly tip: the
 * helper's own set is eight names and TOOLSENABLED_STATE_PATH is not among
 * them, which is where approval grants are minted and consumed. Judging and
 * resolving are the helper's half; deciding what must be fenced is the
 * caller's.
 */

import { createRequire } from 'node:module'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
/* tools/lib/<name>, so the repository root is two levels up. */
const ROOT = path.resolve(import.meta.dirname, '..', '..')

export const FENCE_ENV = 'MC_VAULT_E2E_SCRATCH_ROOT'

/* THE AUTHORITIES, AND A FLOOR UNDER EACH.
 *
 * Derived, not declared, because a declared set is complete on the day it is
 * written and silently stops being: the day the product gains a fourth
 * provider, `install-profile-guard` enumerates it and a hand list does not, and
 * the fence reports clean while a new provider home points at the owner's
 * account. That is the same failure four times over in this lane.
 *
 * PER-AUTHORITY FLOORS, not one floor over the union. A single count cannot say
 * WHICH source went quiet, and the profile authority returning zero would still
 * leave the union above twenty. An authority that half-loads produces a SHORT
 * LIST rather than an error, and without a floor a fence carries on
 * confidently over five names.
 */
const AUTHORITIES = Object.freeze([
  Object.freeze({
    module: 'shell/capability-path-environment.cjs',
    keys: Object.freeze(['CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES']),
    floor: 20,
    category: 'capability path overrides',
  }),
  Object.freeze({
    module: 'shell/install-profile-guard.cjs',
    keys: Object.freeze(['STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES']),
    floor: 4,
    category: 'OS profile roots',
  }),
  Object.freeze({
    module: 'shell/install-profile-guard.cjs',
    keys: Object.freeze(['PROVIDER_HOME_ENVIRONMENT_NAMES']),
    floor: 3,
    category: 'provider account homes',
  }),
  /* NODE_OPTIONS and NODE_PATH. Account-identity tier: NODE_PATH decides module
     resolution, so one pointed into the installation would have the run load
     the installation's modules, but neither is written through. */
  Object.freeze({
    module: 'shell/install-profile-guard.cjs',
    keys: Object.freeze(['NODE_LOADER_ENVIRONMENT_NAMES']),
    floor: 2,
    category: 'node loader',
  }),
])

/* THE ONE DECLARED NAME, and the only one that should ever be declared. It is a
   test seam: zero occurrences in both authority modules, which is correct --
   the product has no reason to enumerate a variable only a test sets. */
export const DECLARED_NAMES = Object.freeze(['MC_TEST_STATE_ROOT'])

/* THE ACCOUNT-IDENTITY TIER IS DERIVED FROM ITS AUTHORITY, not listed here.
 *
 * It is `install-profile-guard`'s own names MINUS whatever the owned tier
 * claims -- which today leaves only NODE_OPTIONS and NODE_PATH. Deriving it
 * rather than hardcoding a list is the same argument as everywhere else here:
 * the day the guard names a fifth account variable, a hardcoded list does not
 * cover it and says nothing.
 *
 * USERPROFILE AND HOME ARE **NOT** IN THIS TIER, AND THE REASON I FIRST GAVE
 * FOR PUTTING THEM HERE WAS FALSE.
 *
 * I wrote, and it travelled upward as the measured basis for exempting the pair
 * in the cut's own fence: "the payload reads them as homeDir in
 * codex-cloud-environments.js, codex-cloud-launch.js and
 * mission-bridge/actions.js, and writes through neither." The first half
 * undercounted and the second half is wrong.
 *
 * MEASURED PROPERLY: seven files under src/ read `process.env.USERPROFILE` or
 * `process.env.HOME` -- those three plus multi-account/launch.js,
 * multi-account/registry-write.js, multi-account/rotation.js and
 * tool-registry.js. (Worker 89 counted twelve READERS; I counted seven FILES.
 * Declared bound: files, not call sites, and either way the three I named was
 * an undercount.)
 *
 * AND THE PRODUCT WRITES AND DELETES THROUGH THEM.
 * `multi-account/registry-write.js` `destroyCredential(entry, spec, { fsImpl,
 * homeDir })` resolves a RELATIVE account directory against that homeDir --
 * `resolveProfileDir({ home: entry[spec.dirField] }, { homeDir })` -- and then
 * calls `fsImpl.unlinkSync(credentialPath)`. The registry writer also
 * `mkdirSync`s a resolved account home. There IS a guard --
 * `isolation.assertIsolatedCredential` refuses a credential path outside the
 * isolation context -- but A GUARD IS NOT AN ABSENCE OF WRITE-THROUGH, and the
 * membership test asks whether the product writes through the variable, not
 * whether something downstream would catch it.
 *
 * So the pair is OWNED and CONTAINED like everything else: `fencedEnvironment`
 * re-points both into the scratch root. An earlier commit of mine moved them
 * out of containment into this tier on the strength of the false sentence
 * above, which is the whole reason the sentence mattered. */
const ACCOUNT_IDENTITY_AUTHORITY_MODULE = 'shell/install-profile-guard.cjs'

/* Case-folded, matched as a BARE SUBSTRING of the whole path -- rule B. */
const LIVE_INSTALL_MARKERS = Object.freeze(['toolsenabled-live'])

export class ScratchFenceRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScratchFenceRefusal'
    this.code = 'SCRATCH_FENCE_REFUSED'
  }
}

/** Absent, non-string and EMPTY all count as absent. Rule A. */
function stated(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Read the authorities at RUN TIME, each with its own floor.
 * @returns {{names: string[], byCategory: Map<string, string[]>}}
 */
export function fenceNameAuthorities({ repoRoot = ROOT, load = require_ } = {}) {
  const byCategory = new Map()
  for (const authority of AUTHORITIES) {
    let module_
    try {
      module_ = load(path.join(repoRoot, ...authority.module.split('/')))
    } catch (error) {
      throw new ScratchFenceRefusal(`${authority.module} could not be read (${error?.code || error?.message}), so the `
        + `${authority.category} category cannot be enumerated and this run will not start.`)
    }
    const names = authority.keys.flatMap(key => (Array.isArray(module_?.[key]) ? module_[key] : []))
      .filter(name => typeof name === 'string' && name.length > 0)
    if (names.length < authority.floor) {
      throw new ScratchFenceRefusal(`${authority.module} produced only ${names.length} name(s) for the `
        + `${authority.category} category, under the floor of ${authority.floor}. An authority that goes quiet, or a `
        + 'require that half-loads, yields a SHORT LIST rather than an error -- so a short read is refused rather '
        + 'than fenced over.')
    }
    byCategory.set(authority.category, [...new Set(names)])
  }
  byCategory.set('declared', [...DECLARED_NAMES])
  return { names: [...new Set([...byCategory.values()].flat())], byCategory }
}

/**
 * WHICH NAMES MUST BE STATED, and which are merely contained when they are.
 *
 * Required: everything whose product default does NOT derive from the fenced
 * state root -- the profile roots, the provider homes, the declared test seam,
 * and the four state and vault paths this run re-points. Plus the audit sinks,
 * which do default under the state root but are re-pointed anyway so that a
 * refusal names the ledger rather than the root.
 */
export function fenceRequiredNames() {
  /* DERIVED FROM `fencedEnvironment` ITSELF, which is the only definition of
   * "owned" that cannot drift: a run OWNS exactly what it RE-POINTS.
   *
   * The first version of this picked names out of the authorities by pattern --
   * the state and vault paths, the audit ones, all of the profile roots, all of
   * the provider homes. That swallowed USERPROFILE and HOME into the owned
   * tier, so the fence demanded they be set AND inside the scratch root, which
   * is the containment rule applied to two names the product only READS. Worse,
   * it was a second hand-picked list wearing derivation's clothes: the two
   * halves of this module could disagree about what the set was.
   *
   * Asking `fencedEnvironment` removes both problems. Whatever it assigns is
   * owned, by construction, and tier (iii) is then everything the authorities
   * name that it does not assign. */
  const probe = path.join(path.sep, 'w87-fence-required-probe')
  const { environment } = fencedEnvironment(probe, {})
  return Object.freeze(Object.keys(environment).filter(name => name !== FENCE_ENV))
}

/**
 * TIER (iii): the account-identity names -- `install-profile-guard`'s own,
 * minus whatever the owned tier claims. Derived, so the day the guard names a
 * fifth account variable it is covered without anybody remembering.
 */
export function accountIdentityNames({ repoRoot = ROOT, load = require_ } = {}) {
  const { byCategory } = fenceNameAuthorities({ repoRoot, load })
  const required = new Set(fenceRequiredNames())
  return Object.freeze([...new Set(
    ['OS profile roots', 'provider account homes', 'node loader']
      .flatMap(category => byCategory.get(category) || [])
      .filter(name => !required.has(name)),
  )])
}

/**
 * THE ORDERING, ASSERTED RATHER THAN READ FROM THE SOURCE.
 *
 * `perUserStateRoot`'s `os.homedir` default is the last ambient input in the
 * resolution chain and is reachable only when STATE_ROOT is unset. The by-name
 * refusal is what prevents it. This proves the refusal comes FIRST by handing
 * the fence an environment with STATE_ROOT unset and a resolver loader that
 * THROWS if it is ever called: if the refusal did not precede resolution, the
 * loader's error would surface instead of the named refusal.
 *
 * @returns {string} the refusal message that proved the ordering
 */
export function assertRefusalPrecedesResolution({ payload, scratchRoot, environment = {}, repoRoot = ROOT } = {}) {
  const withoutStateRoot = { ...environment }
  delete withoutStateRoot.TOOLSENABLED_STATE_ROOT
  const reached = []
  const tripwire = () => {
    reached.push('resolvers')
    throw new Error('RESOLVER REACHED BEFORE THE FENCE REFUSED -- os.homedir was reachable')
  }
  try {
    assertScratchFence({ payload, scratchRoot, environment: withoutStateRoot, loadResolvers: tripwire, repoRoot })
  } catch (error) {
    /* THE PROPERTY IS "NO RESOLVER WAS REACHED", NOT "THIS PARTICULAR NAME
     * REFUSED FIRST", AND THAT DISTINCTION WAS A FALSE NEGATIVE IN THIS CHECK.
     *
     * The first version demanded the message start with TOOLSENABLED_STATE_ROOT.
     * Handed an incomplete base -- the exported default of `{}` -- it reported
     * "does NOT precede" because TOOLSENABLED_STATE_PATH sorts earlier in the
     * required set and is refused first. So it conflated "another name refused
     * before this one" with "resolution happened", and cried failure over a
     * property that held.
     *
     * That is the mirror of everything else this lane has found, and worse in
     * one way: a check that can be wrong in the alarming direction trains the
     * next person to dismiss its reds. My own line applies to it -- an
     * assertion that cannot be right is worse than one that is missing.
     *
     * ANY absence refusal proves the ordering, because the whole absence loop
     * runs before the resolvers are loaded. The tripwire is what distinguishes
     * the two cases, so it is what gets asserted. */
    if (reached.length > 0) {
      throw new ScratchFenceRefusal('a path resolver was reached before the fence refused an environment with '
        + `TOOLSENABLED_STATE_ROOT unset, so perUserStateRoot's os.homedir default is reachable: ${error?.message}`)
    }
    if (error instanceof ScratchFenceRefusal && /\bis (not set|empty)\b/.test(error.message)) {
      return error.message
    }
    throw new ScratchFenceRefusal('the fence refused for a reason that is not an absence, so this check cannot say '
      + `whether the absence refusal precedes resolution: ${error?.message}`)
  }
  throw new ScratchFenceRefusal('the fence CLEARED an environment with TOOLSENABLED_STATE_ROOT unset, so nothing '
    + "prevents perUserStateRoot's os.homedir default.")
}

/**
 * MAY THIS RUN TOUCH THE DISK IT IS ABOUT TO TOUCH.
 *
 * @param {object} options
 * @param {string} options.payload  the capability payload to resolve through
 * @param {string} options.scratchRoot  the root THIS RUN created
 * @param {object} [options.environment]
 * @param {string[]} [options.required] override the required set; defaults to
 *   the derived one. A caller swapping in a shared helper passes its own set
 *   through so the helper judges the caller's, not its own.
 * @param {Function} [options.loadResolvers] the payload's PURE path resolvers
 * @param {object} [options.alsoClear] extra { label: path }, same rules
 * @param {Function} [options.onCleared] told each label and path as it passes
 * @returns {object} every resolved path, keyed by label
 * @throws {ScratchFenceRefusal}
 */
export function assertScratchFence({
  payload,
  scratchRoot,
  environment = process.env,
  required = undefined,
  repoRoot = ROOT,
  loadResolvers = undefined,
  alsoClear = {},
  onCleared = () => {},
} = {}) {
  if (typeof payload !== 'string' || !payload) throw new ScratchFenceRefusal('no capability payload was named to resolve through.')
  if (typeof scratchRoot !== 'string' || !scratchRoot) throw new ScratchFenceRefusal('no scratch root was named, so nothing could be fenced.')
  const root = path.resolve(scratchRoot)

  const { names: enumerated, byCategory } = fenceNameAuthorities({ repoRoot, load: require_ })
  const requiredNames = required || fenceRequiredNames()

  /* RULE A, PER NAME, before any resolver is loaded. This is the ordering that
     keeps os.homedir out of reach. */
  for (const name of requiredNames) {
    const value = environment[name]
    if (typeof value === 'string' && value.length > 0 && value.trim().length === 0) {
      throw new ScratchFenceRefusal(`${name} is empty. An empty string is neither absent nor a path, and would slip `
        + 'past a presence test -- so it is refused as absence.')
    }
    if (!stated(value)) {
      throw new ScratchFenceRefusal(`${name} is not set. An unset name is the DANGEROUS state, not the safe one: the `
        + 'product then picks its own default, and for this name that default derives from the profile or the OS '
        + 'rather than from anything this fence has fenced.')
    }
  }

  const load = loadResolvers || (() => ({
    stateRootModule: require_(path.join(payload, 'src', 'lib', 'runtime-state-root.js')),
    vaultLocation: require_(path.join(payload, 'src', 'lib', 'vault-location.js')),
  }))
  let resolvers
  try {
    resolvers = load()
  } catch (error) {
    throw new ScratchFenceRefusal(`${payload} could not supply its path resolvers (${error?.code || error?.message}), `
      + 'so where this run would touch is unknown. An unknown path is not a safe path.')
  }

  /* RULE B. */
  const namesLiveInstall = candidate => {
    const folded = candidate.toLowerCase()
    return LIVE_INSTALL_MARKERS.some(marker => folded.includes(marker))
  }
  const assertNotLive = (label, resolved) => {
    if (!stated(resolved)) {
      throw new ScratchFenceRefusal(`the ${label} could not be resolved, so this run will not start. `
        + 'An unresolved path is not a safe path.')
    }
    const full = path.resolve(resolved)
    if (namesLiveInstall(full)) {
      throw new ScratchFenceRefusal(`the ${label} resolves INSIDE THE LIVE INSTALLATION (${full}). This run reaches `
        + "a real vault lifecycle verb; it will not run against the owner's own installation.")
    }
    return full
  }
  /* RULE C, on top of B. */
  const clear = (label, resolved) => {
    const full = assertNotLive(label, resolved)
    const relative = path.relative(root, full)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ScratchFenceRefusal(`the ${label} resolves outside this run's scratch root.\n    resolved: ${full}\n`
        + `    scratch:  ${root}\n    Anything this run writes through must land somewhere disposable.`)
    }
    onCleared(label, full)
    return full
  }

  /* RULE 4 of the load order: resolveStateRoot({environment}).root, not
     stateRoot() -- which fs.mkdirSync's the directory the fence has not judged.
     And resolveVaultLocation({environment}).file, not vaultPath() -- which
     takes no arguments and reads process.env, so this function was not a
     function of the environment it was handed and answered the LIVE vault for a
     safe one. */
  const resolvedStateRoot = resolvers.stateRootModule.resolveStateRoot({ environment }).root

  /* The ledger BY SHAPE, not by name, so a product rename cannot leave a dead
     check: the audit variable that names a database, taken from the
     enumeration. */
  const ledgerName = (byCategory.get('capability path overrides') || [])
    .find(name => /AUDIT/.test(name) && /(_DB|DATABASE)$/.test(name))
  if (!ledgerName) {
    throw new ScratchFenceRefusal('the product enumerates no audit database path override, so the ledger this run '
      + 'would write to cannot be established by shape.')
  }
  const ledger = stated(environment[ledgerName])
    ? environment[ledgerName].trim()
    : path.join(resolvedStateRoot, 'state', 'audit.sqlite3')

  const cleared = {
    stateRoot: clear('state root', resolvedStateRoot),
    vaultFile: clear('vault file', resolvers.vaultLocation.resolveVaultLocation({ environment }).file),
    auditLedger: clear(`audit ledger (via ${ledgerName})`, ledger),
  }

  /* THE THREE TIERS. Tier (i), the owned names, were required above and are
   * cleared below with the rest. The split between (ii) and (iii) is BY
   * AUTHORITY, which is what makes it derivable:
   *
   *   (ii) PRODUCT OVERRIDES -- capability-path-environment's names. UNSET IS
   *        FINE, and this is the one place in this file where absence is
   *        tolerated, so the reason must travel with the rule: THEIR PRODUCT
   *        DEFAULTS DERIVE FROM THE STATE ROOT, and the state root is fenced by
   *        name before any of this runs -- so an absent one lands inside the
   *        fence anyway. That is the WEAK form of the absence rule and it is
   *        correct ONLY here. Do not copy it into tier (i), where absence means
   *        the product picks a default from the profile or the OS and is the
   *        DANGEROUS state.
   *        But IF SET they must be CONTAINED, not merely not-live. Measured:
   *        TOOLSENABLED_RESEARCH_DB pointed at C:\elsewhere\research.sqlite3
   *        was ACCEPTED under a not-live-only rule, and providers/web.js opens
   *        exactly that path as its sqlite evidence database -- accepted, then
   *        written through. A survey of the swept names found write-bearing
   *        readers for 22 of 26 (bound: file-level grep, not per-variable data
   *        flow, so 22 is an upper bound on certainty rather than a count of
   *        proven writes). Containment is the right rule for the category.
   *
   *   (iii) ACCOUNT IDENTITY -- install-profile-guard's names that the owned
   *        tier does not claim. Not-live only; see the note above
   *        ACCOUNT_IDENTITY_AUTHORITY_MODULE for the measurement.
   */
  const accountIdentity = new Set(
    [...byCategory.entries()]
      .filter(([category]) => ['OS profile roots', 'provider account homes', 'node loader'].includes(category))
      .flatMap(([, names]) => names)
      .filter(name => !requiredNames.includes(name)),
  )
  /* COSMETIC, AND IT WAS REAL: `cleared` is keyed by LABEL, so the three
     semantic entries above and the by-name sweep below both covered
     STATE_ROOT, VAULT_PATH and the ledger -- printing each of them twice. The
     variables those three consumed are recorded and skipped rather than the
     print being suppressed, so the skip is visible in the code instead of the
     duplicate being hidden in the output. */
  const alreadyCleared = new Set(['TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_VAULT_PATH', ledgerName])
  for (const name of enumerated) {
    if (alreadyCleared.has(name)) continue
    const value = environment[name]
    if (!stated(value)) continue
    if (accountIdentity.has(name)) {
      cleared[name] = assertNotLive(`account identity ${name}`, value.trim())
      continue
    }
    cleared[name] = clear(name, value.trim())
  }

  for (const [label, candidate] of Object.entries(alsoClear)) cleared[label] = clear(label, candidate)
  return cleared
}

/**
 * The environment a fenced child runs under, and the directories those paths
 * need. Beside the fence on purpose: the two halves must name the same set, and
 * a caller keeping its own copy is the drift this removes. A caller that had to
 * know which name is a file and which a directory would be a second copy of
 * that knowledge.
 */
export function fencedEnvironment(scratchRoot, base = process.env) {
  const stateRootDirectory = path.join(scratchRoot, 'state-root')
  const providerHomes = path.join(scratchRoot, 'provider-homes')
  const environment = {
    ...base,
    [FENCE_ENV]: scratchRoot,
    TOOLSENABLED_STATE_ROOT: stateRootDirectory,
    MC_TEST_STATE_ROOT: stateRootDirectory,
    TOOLSENABLED_VAULT_PATH: path.join(stateRootDirectory, 'vault', 'secrets.json'),
    TOOLSENABLED_STATE_PATH: path.join(scratchRoot, 'state.sqlite3'),
    LOCALAPPDATA: path.join(scratchRoot, 'LocalAppData'),
    APPDATA: path.join(scratchRoot, 'RoamingAppData'),
    /* CONTAINED, because the product WRITES AND DELETES through these -- see the
       note above ACCOUNT_IDENTITY_AUTHORITY_MODULE. multi-account's
       destroyCredential resolves a relative account directory against this
       homeDir and unlinks the credential it finds there. */
    USERPROFILE: path.join(scratchRoot, 'profile'),
    HOME: path.join(scratchRoot, 'profile'),
    TOOLSENABLED_AUDIT_DB: path.join(stateRootDirectory, 'state', 'audit.sqlite3'),
    TOOLSENABLED_AUDIT_JSONL_PATH: path.join(scratchRoot, 'logs', 'actions.jsonl'),
    TOOLSENABLED_AUDIT_TEXT_PATH: path.join(scratchRoot, 'logs', 'actions.log'),
    TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(scratchRoot, 'logs', 'audit-emergency.jsonl'),
    CODEX_HOME: path.join(providerHomes, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(providerHomes, 'claude'),
    GEMINI_DIR: path.join(providerHomes, 'gemini'),
  }
  return Object.freeze({
    environment: Object.freeze(environment),
    directories: Object.freeze([
      environment.LOCALAPPDATA,
      environment.APPDATA,
      environment.USERPROFILE,
      stateRootDirectory,
      path.join(stateRootDirectory, 'vault'),
      path.join(stateRootDirectory, 'state'),
      path.join(scratchRoot, 'logs'),
      environment.CODEX_HOME,
      environment.CLAUDE_CONFIG_DIR,
      environment.GEMINI_DIR,
      path.join(scratchRoot, 'services'),
      path.join(scratchRoot, 'workspace'),
    ]),
  })
}

/* NO FLAT `REDIRECTED_PATH_VARIABLES` EXPORT ANY MORE, deliberately. Callers
   take `fenceRequiredNames()` and `fenceNameAuthorities()`, which read the
   product at run time. A frozen constant would be the same thing this fence
   exists to refuse: a set complete on the day it was written. (The first draft
   of this rewrite left the old name exported as an empty frozen array for
   compatibility -- which would have had every caller loop over nothing and
   report clean. An export that cannot be right is worse than one that is
   missing, because the missing one is a load error and the empty one is a
   green run.) */
