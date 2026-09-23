/* THE FENCE THAT KEEPS A MEASUREMENT OFF THE OWNER'S LIVE INSTALLATION.
 *
 * WHY IT IS SHARED. The shell of every agent circle on a machine running this
 * product arrives carrying TOOLSENABLED_STATE_ROOT, TOOLSENABLED_VAULT_PATH and
 * CLAUDE_CONFIG_DIR already pointing into the running installation's private
 * profile. tools/test-ratchet.mjs records what that costs: on 2026-09-10 a
 * measurement engine started from an agent shell wrote four real entries into
 * the owner's LIVE ledger. A fence a caller assembles from five exports is a
 * fence somebody assembles wrong; import this and call assertScratchFence once.
 *
 * ── NO HAND LIST ───────────────────────────────────────────────────────────
 * The names come from the product's own enumerations, read at call time, each
 * with its own short-read refusal so a source going quiet is NAMED rather than
 * silently reading as an empty category:
 *
 *   capability overrides  shell/capability-path-environment.cjs
 *                         CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES
 *                         (31 today; its own regression test keeps it in step
 *                         with capability/src). Refuses under 20.
 *   account paths         shell/install-profile-guard.cjs
 *                         STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES. Refuses under 4.
 *   provider homes        shell/install-profile-guard.cjs
 *                         PROVIDER_HOME_ENVIRONMENT_NAMES. Refuses under 3.
 *
 * Plus exactly ONE declared name, with its reason: MC_TEST_STATE_ROOT, a test
 * harness seam that no product authority enumerates because the product never
 * reads it. There is deliberately NO TOTAL written down anywhere here: a
 * hand-maintained total is the number that rots, so each authority states only
 * its own floor.
 *
 * BEING ENUMERATED IS NOT THE SAME AS BEING RE-POINTED. The derivation says
 * which names the product READS. The owned set says which names a run must
 * OWN. Neither replaces the other, and a name can be in both.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * Every enumerated name that is SET must resolve inside the run's scratch,
 * whatever its category. The owned names must also BE set: unset and empty both
 * refuse for absence, because an unset name means the product picks its own
 * default, which can derive from the installation rather than the state root
 * and land on the owner's real ledger while the environment looks blank.
 *
 * The capability overrides may legitimately be unset -- their defaults derive
 * from the fenced state root, so absence is already inside the fence -- but if
 * set they must be contained like everything else.
 *
 * THE CONTAINMENT-EXEMPT NAMES, AND WHERE THEIR REASONS LIVE. USERPROFILE and
 * HOME, and the node loader variables, are held to the not-live rule only. Each
 * exemption's reason sits on its own constant below, and each states the
 * MEASUREMENT it rests on and THE WIDTH of that measurement -- not a conclusion
 * like "read-only". An earlier version of this file said exactly that about
 * USERPROFILE/HOME on the strength of three files, and it was false: the pair is
 * written and deleted through. That error survived its mutation check, because a
 * mutation proves an assertion is falsifiable and not that it asserts the right
 * thing. Every other set name is contained, whichever way the unmeasured names
 * fall, so there is no per-name write-through sorting -- that is a heuristic.
 *
 * ── PURITY, WHICH IS MEASURED AND NOT ASSERTED ─────────────────────────────
 * Worker 87's first fenced driver resolved the audit database by calling
 * getStateStore(), which OPENS the store: the check meant to keep a run off the
 * live database would have opened the live database to find out where it was.
 * A later one required audit-store.js, which CREATES the state-root directory
 * at module load. So this module has no top-level execution, is importable
 * without side effects, and resolves every path as string arithmetic. Its test
 * hooks fs and child_process across import plus a full resolve-and-judge on a
 * live environment and asserts zero calls; the name of a function is not the
 * proof.
 *
 * A FUNCTION OF WHAT IT IS HANDED. Nothing here reads process.env. Worker 87's
 * fence called a no-argument vaultPath() that read the ambient environment and
 * answered the LIVE vault when handed a safe scratch environment -- and every
 * refusal proof still passed, because refusing a live vault is what they test.
 * The environment is a parameter, always.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { OWNED_STATE_ROOT_NAMES } from '../check-no-owner-data.mjs'

/* The marker of an installed, running copy, matched CASE-FOLDED as a BARE
 * SUBSTRING of the raw value. Not segment-matched and NOT separator-normalised:
 * another lane normalised separators and watched it fail open twice, the
 * backslash collapse happening silently through sed and again through a quoted
 * heredoc. A substring test has no separator handling to get wrong, so it
 * catches the backslash, upper-cased, forward-slash and msys /c/ spellings with
 * one comparison. Deliberately fail-closed: a directory merely NAMED like the
 * installation is refused too. */
export const LIVE_INSTALLATION_SEGMENT = 'ToolsEnabled-Live'

/* USERPROFILE and HOME: CONTAINMENT-EXEMPT, AND HERE IS THE MEASUREMENT.
 *
 * THE EARLIER REASON WAS WRONG, AND WRONG IN THE WAY THAT SURVIVES A MUTATION
 * CHECK. It read "the product measurably only READS them", from finding homeDir
 * in three files. A mutation proves an assertion is falsifiable, not that it
 * asserts the right thing; a faithful test of a false premise passes honestly.
 * Only an external correction catches that, so what a reason must record is the
 * measurement AND ITS WIDTH, not the conclusion drawn from it.
 *
 * MEASUREMENT, 2026-09-17, width: capability/src/lib/multi-account/registry-write.js
 * read in full, plus the guard it calls. The pair IS written and deleted
 * through:
 *   registry-write.js:391 and :493  homeDir = process.env.USERPROFILE || process.env.HOME || ''
 *   registry-write.js:452           fsImpl.mkdirSync(home, { recursive: true })   -- creates an account home
 *   registry-write.js:309           fsImpl.unlinkSync(credentialPath)             -- destroyCredential
 * so "read-only" was a subset finding, not a fact about the product.
 *
 * WHY THE EXEMPTION STILL STANDS, on a different basis. The delete at :309 does
 * not take a raw path: :307 passes it through
 * provider-session-isolation.js:129 assertIsolatedCredential, which refuses a
 * credential path outside the isolation context. That is a SECOND FENCE, not an
 * absence of write-through, and it is tested here -- with a mutation that
 * removes it -- rather than taken on trust.
 *
 * AND WHY NOT SIMPLY CONTAIN THEM. Redirecting USERPROFILE/HOME into the cut
 * scratch is what a driver can afford and a cut cannot: git reads the profile
 * for its config and credential helper, npm for .npmrc and its cache, and
 * electron-builder for its download cache. A cut that redirected them would
 * change what the dist chain resolves, which is the opposite of measuring the
 * candidate. So: not-live rule only, plus the named second fence.
 *
 * NOT MEASURED, AND SAID SO: the twelve other homeDir readers were not read in
 * full. If any of them writes outside assertIsolatedCredential, this exemption
 * needs revisiting and this comment is where that starts. */
export const ACCOUNT_IDENTITY_NAMES = Object.freeze(['USERPROFILE', 'HOME'])

/* CATEGORY 5: THE NODE LOADER VARIABLES -- what the environment DECIDES, not
 * what it writes. NODE_PATH decides module resolution, so a NODE_PATH pointed
 * into the installation makes a run load the INSTALLATION'S modules while every
 * path-writing check stays green; NODE_OPTIONS can do the same through
 * --require preloads. Nothing is written through either, which is exactly why a
 * fence that only asks "what gets written" never sees them. Their own authority
 * with its own floor, so a short read is named like any other. */
export const NODE_LOADER_NAMES = Object.freeze(['NODE_PATH', 'NODE_OPTIONS'])

/* THE CONTAINMENT-EXEMPT TIER, BY NAME, EACH WITH ITS OWN MEASURED REASON.
 *
 * Not a list with one comment over it. A refuted premise left above a generic
 * loop re-adopts itself the day a new name lands in that tier -- which is how
 * "the product only reads these" came to cover USERPROFILE and HOME after it
 * had been measured false. Keyed by name, so a new member cannot inherit
 * somebody else's sentence: adding one means writing what was measured about
 * IT. Every member is still held to the not-live rule; exempt means exempt from
 * CONTAINMENT only. */
export const CONTAINMENT_EXEMPT_REASONS = Object.freeze({
  USERPROFILE: 'the dist chain resolves the real profile through git (config, credential helper), npm (.npmrc, cache) and electron-builder (download cache); containing it would change what the chain resolves. Measured 2026-09-17 on multi-account/registry-write.js read in full: the pair IS written and deleted through (:452 mkdirSync, :309 unlinkSync), and the delete is separately fenced by provider-session-isolation.js assertIsolatedCredential (:307), tested in tools/test/cut-account-home-exemption.test.mjs. Width: one file plus that guard; the twelve other homeDir readers were NOT read in full.',
  HOME: 'the POSIX arm of the same read: multi-account/registry-write.js resolves homeDir = process.env.USERPROFILE || process.env.HOME at :391 and :493, so HOME reaches the same mkdirSync (:452) and unlinkSync (:309) and is covered by the same provider-session-isolation.js assertIsolatedCredential (:307). Same width: that one file plus the guard.',
  NODE_PATH: 'buildDistChainEnvironment in tools/release-packager/cut-release-candidate.mjs EMPTIES it for the cut children rather than re-pointing it, so there is no scratch path for it to be inside. Emptied because it decides module resolution: pointed into the installation, node would load the installation\'s modules while every path-writing check stayed green.',
  NODE_OPTIONS: 'emptied by the same loop in tools/release-packager/cut-release-candidate.mjs buildDistChainEnvironment, for the same reason: --require preloads reach the same outcome as NODE_PATH without naming a module directory.',
})

/* The names a run must OWN: set, and inside its scratch. */
/* ONE LIST, OWNED BY THE GUARD. tools/check-no-owner-data.mjs derives the
 * owner's workspace spellings from these same variables and must stay a single
 * file (its test copies it alone into a fixture root), so the list lives there
 * and this fence imports it. T334 review: the two copies had already drifted --
 * the guard's omitted APPDATA and LOCALAPPDATA -- and a drift here is a state
 * root the fence re-points but the guard never reads. Importing the guard runs
 * nothing: its main() is behind an entry-point check. */
export const OWNED_NAMES = OWNED_STATE_ROOT_NAMES

const AUTHORITIES = Object.freeze([
  { category: 'capability overrides', module: '../../shell/capability-path-environment.cjs', exportName: 'CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES', floor: 20 },
  { category: 'account paths', module: '../../shell/install-profile-guard.cjs', exportName: 'STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES', floor: 4 },
  { category: 'provider homes', module: '../../shell/install-profile-guard.cjs', exportName: 'PROVIDER_HOME_ENVIRONMENT_NAMES', floor: 3 },
])

/* Lazy, so importing this module executes nothing. Each authority refuses in
 * its own name: a source that has gone quiet must be reported, never read as
 * an empty category. */
export function readAuthorities({ load = createRequire(import.meta.url), authorities = AUTHORITIES } = {}) {
  return authorities.map(({ category, module: specifier, exportName, floor }) => {
    let values
    try {
      values = load(specifier)?.[exportName]
    } catch (error) {
      throw new Error(
        `the fence could not read its "${category}" authority (${exportName} from ${specifier}): ` +
          `${error instanceof Error ? error.message : String(error)}. Refusing rather than fencing a partial set.`,
      )
    }
    if (!Array.isArray(values) || values.length < floor) {
      throw new Error(
        `the fence's "${category}" authority returned ${Array.isArray(values) ? values.length : 'no'} name(s), ` +
          `below its floor of ${floor} (${exportName} from ${specifier}). ` +
          'A source that has gone quiet must be named, not read as an empty category.',
      )
    }
    return { category, names: [...values] }
  })
}

/* Every name the fence knows, by category, with the one declared seam. */
export function requiredNames(options = {}) {
  const groups = readAuthorities(options)
  groups.push({
    category: 'node loader',
    /* Floor 2, stated here rather than in AUTHORITIES because these are not a
     * product enumeration: node owns them. A short read is still named. */
    names: [...NODE_LOADER_NAMES],
  })
  if (groups[groups.length - 1].names.length < 2) {
    throw new Error('the fence "node loader" category returned fewer than 2 names, below its floor of 2. A source that has gone quiet must be named, not read as an empty category.')
  }
  groups.push({
    category: 'test harness seam',
    /* Declared, with its reason: the product never reads MC_TEST_STATE_ROOT, so
     * no product authority can enumerate it, but tools/test-strict.mjs and the
     * release packager both set it and a run that leaves it pointed at a live
     * tree measures that tree. */
    names: ['MC_TEST_STATE_ROOT'],
  })
  const seen = new Set()
  const all = []
  for (const group of groups) {
    for (const name of group.names) if (!seen.has(name)) { seen.add(name); all.push(name) }
  }
  return { groups, names: all }
}

/** Case-folded bare substring: no separator handling, so none to get wrong. */
export function isLiveInstallationPath(value) {
  return String(value).toLowerCase().includes(LIVE_INSTALLATION_SEGMENT.toLowerCase())
}

/** Pure containment. */
export function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/* The audit database is identified BY SHAPE from the enumeration -- a name
 * containing AUDIT and ending _DB or DATABASE -- rather than by a literal, so a
 * rename in the product does not quietly drop it out of the fence. The bare
 * AUDIT_JSONL / AUDIT_TEXT / AUDIT_EMERGENCY spellings are deliberately NOT
 * treated as the enumeration's names; the real ones carry the TOOLSENABLED_
 * prefix and the _PATH suffix, and the test asserts the bare forms are absent. */
export function auditDatabaseNames(names) {
  return names.filter((name) => /AUDIT/.test(name) && /(_DB|DATABASE)$/.test(name))
}

/* THE LEDGER DOES NOT FOLLOW THE STATE ROOT. src/lib/audit.js boundLedgerFile()
 * returns TOOLSENABLED_AUDIT_DB when set and only otherwise falls back to
 * audit-store.js DEFAULT_AUDIT_DB = rootPath('state','audit.sqlite3'); its
 * companions resolve the same way through configuredFile(). So a scratch state
 * root with the ledger still aimed at the installation passes a
 * state-root-only fence while writing the owner's real ledger. Derived from
 * that shape, PURE, and never by requiring audit-store.js -- which creates the
 * state-root directory at module load. */
export const AUDIT_LEDGER_FALLBACKS = Object.freeze([
  { name: 'TOOLSENABLED_AUDIT_DB', fallback: ['state', 'audit.sqlite3'], label: 'audit ledger' },
  { name: 'TOOLSENABLED_AUDIT_JSONL_PATH', fallback: ['logs', 'actions.jsonl'], label: 'audit jsonl log' },
  { name: 'TOOLSENABLED_AUDIT_TEXT_PATH', fallback: ['logs', 'actions.log'], label: 'audit text log' },
  { name: 'TOOLSENABLED_AUDIT_EMERGENCY_PATH', fallback: ['logs', 'audit-emergency.jsonl'], label: 'audit emergency spool' },
])

function trimmed(env, name) {
  const raw = env?.[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

/* PURE, AND THE ONLY RESOLVER. Every path the fence judges is resolved here, as
 * string arithmetic over the environment OBJECT handed in, so no importer has
 * to decide between stateRoot() and resolveStateRoot() on its own. */
export function resolveFencedPaths(env, options = {}) {
  if (!env || typeof env !== 'object') throw new Error('the fence resolves an environment object it is handed; it never reads process.env')
  const { names } = requiredNames(options)
  const stateRootRaw = trimmed(env, 'TOOLSENABLED_STATE_ROOT')
  const stateRoot = stateRootRaw ? path.resolve(stateRootRaw) : null

  const entries = names.map((name) => {
    const raw = trimmed(env, name)
    return { name, label: name, raw, resolved: raw ? path.resolve(raw) : null, derived: false }
  })

  for (const { name, fallback, label } of AUDIT_LEDGER_FALLBACKS) {
    const raw = trimmed(env, name)
    if (raw) continue
    entries.push({
      name,
      label: `the ${label} derived from TOOLSENABLED_STATE_ROOT`,
      raw: '',
      resolved: stateRoot ? path.join(stateRoot, ...fallback) : null,
      derived: true,
    })
  }
  return entries
}

/* The one call a driver makes. */
export function assertScratchFence(env, { scratchRoots = [], owned = OWNED_NAMES, ...options } = {}) {
  const roots = scratchRoots.filter(Boolean).map((root) => path.resolve(root))
  const entries = resolveFencedPaths(env, options)
  const problems = []
  /* Containment-exempt, not-live ALWAYS. Membership is read from
   * CONTAINMENT_EXEMPT_REASONS, which is keyed BY NAME with each member's own
   * measured reason, so a name cannot join this tier by landing in a list and
   * inheriting a sentence written about somebody else. A refuted premise left
   * as a comment above a generic loop re-adopts itself the day a new name
   * arrives; this shape makes that impossible without writing a new reason. */
  const exempt = new Set(Object.keys(CONTAINMENT_EXEMPT_REASONS))

  for (const name of owned) {
    if (!trimmed(env, name)) {
      problems.push(`${name} is unset or empty, and a run must OWN it: an absent name means the product picks its own default, which can derive from the installation rather than the state root`)
    }
  }

  for (const entry of entries) {
    if (entry.resolved === null) {
      if (entry.derived) {
        problems.push(`${entry.label} cannot be resolved because TOOLSENABLED_STATE_ROOT is not set, and an unresolved path is not a safe path`)
      }
      continue
    }
    if (isLiveInstallationPath(entry.raw || entry.resolved) || isLiveInstallationPath(entry.resolved)) {
      problems.push(`${entry.label} resolves inside a live installation: ${entry.resolved}`)
      continue
    }
    if (exempt.has(entry.name)) continue
    if (roots.length && !roots.some((root) => isInside(root, entry.resolved))) {
      problems.push(`${entry.label} resolves outside this run's scratch: ${entry.resolved}`)
    }
  }

  if (problems.length) {
    throw new Error(
      `refusing to measure: ${problems.length} fenced path(s) would reach state this run does not own:\n  ` +
        problems.join('\n  ') +
        '\n  Point them at a scratch directory used by nothing else.' +
        '\n  Nothing has been opened, spawned or written.',
    )
  }
  return entries
}
