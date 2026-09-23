// THE FENCE, PROVED RATHER THAN ASSERTED.
//
// Three defects from other lanes shape this file. Worker 87's first fenced
// driver resolved the audit database by calling getStateStore(), which OPENS
// the store, so the check meant to keep a run off the live database would have
// opened it to find out where it was. A later one required audit-store.js,
// which CREATES the state-root directory at module load. And Worker 87's fence
// called a no-argument vaultPath() that read the AMBIENT environment and
// answered the live vault when handed a safe scratch one -- while every refusal
// proof still passed, because refusing a live vault is what they test.
//
// So purity here is measured with a real hook, not inferred from a name, and
// the "handed a safe environment while process.env is live" case is explicit.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  ACCOUNT_IDENTITY_NAMES,
  CONTAINMENT_EXEMPT_REASONS,
  NODE_LOADER_NAMES,
  LIVE_INSTALLATION_SEGMENT,
  OWNED_NAMES,
  assertScratchFence,
  auditDatabaseNames,
  isInside,
  isLiveInstallationPath,
  readAuthorities,
  requiredNames,
  resolveFencedPaths,
} from '../lib/scratch-fence.mjs'

/* ── THE RULE, STATED INDEPENDENTLY OF THE THING THAT IMPLEMENTS IT ──────────
 *
 * DERIVE THE PRODUCT, LITERALISE THE EXPECTATION. Three assertions in this file
 * used to take BOTH sides from the fence -- the exempt tier compared against
 * ACCOUNT_IDENTITY_NAMES + NODE_LOADER_NAMES, the scrub count compared against
 * requiredNames().length, and the owned set compared against what
 * buildDistChainEnvironment re-points. Each proved the two halves agree and
 * nothing about whether either is right: dropping a name from both sides left
 * them fully green. Worker 89 found the same shape in another lane, where
 * removing TOOLSENABLED_VAULT_PATH from the re-pointed set left its QA green.
 *
 * So the owned set and the exempt tier are WRITTEN DOWN HERE, by hand, and the
 * derivations are checked against them. What stays derived is what the PRODUCT
 * enumerates -- adding a capability override should not require editing a test
 * -- but each authority still has a literal floor, and the names a run must own
 * are a decision, not a discovery. */
const OWNED_BY_RULE = [
  'APPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_DIR',
  'LOCALAPPDATA',
  'MC_TEST_STATE_ROOT',
  'TOOLSENABLED_STATE_PATH',
  'TOOLSENABLED_STATE_ROOT',
  'TOOLSENABLED_VAULT_PATH',
]
const CONTAINMENT_EXEMPT_BY_RULE = ['HOME', 'NODE_OPTIONS', 'NODE_PATH', 'USERPROFILE']
/* Names the capability authority must carry. Not the whole list -- that is the
 * product's to grow -- but a run whose scrub lost any of these is not fenced. */
const CAPABILITY_MUST_INCLUDE = [
  'TOOLSENABLED_AUDIT_DB',
  'TOOLSENABLED_STATE_PATH',
  'TOOLSENABLED_STATE_ROOT',
  'TOOLSENABLED_VAULT_PATH',
]
const FLOOR_BY_RULE = { 'capability overrides': 20, 'account paths': 4, 'provider homes': 3, 'node loader': 2 }

/* Does a path cited in an exemption reason name a real file? Searched by its
 * TAIL, because a reason cites the readable part of a path
 * ("multi-account/registry-write.js") rather than a full repo-relative one, and
 * across the two trees a reason can legitimately point at: this repository and
 * the staged capability payload. Returns false rather than throwing, so the
 * assertion reports the citation that failed. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Every file path a reason cites. */
function citationsIn(reason) {
  return [...String(reason).matchAll(/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|mjs|cjs|ps1|json))/g)]
    .map((match) => match[1])
}

/* IS THE ENGINE PAYLOAD REACHABLE AT ALL?
 *
 * Two of the four reasons cite engine files -- registry-write.js and
 * provider-session-isolation.js -- which live in the capability payload, not in
 * this repository. In a cut the payload is packed and the variables are set, so
 * the citation check runs fully; that is the point of it. In a fresh clone with
 * nothing packed there is nothing to look at, and "could not look" is a NAMED
 * SKIP in this codebase, never a red: a suite that runs red for an environment
 * reason teaches the next reader to discount it, which costs more than the
 * check is worth. Reports WHY, so the skip line says what was missing. */
function enginePayloadReachable() {
  const named = process.env.MC_TEST_CAPABILITY_PAYLOAD || process.env.MC_CANONICAL_ROOT || process.env.TOOLSENABLED_SOURCE
  if (named && fs.existsSync(path.join(named, 'src', 'lib'))) return { reachable: true, how: `engine root ${named}` }
  if (fs.existsSync(path.join(REPO_ROOT, 'capability', 'src', 'lib'))) {
    return { reachable: true, how: `packed payload at ${path.join(REPO_ROOT, 'capability')}` }
  }
  return {
    reachable: false,
    why: named
      ? `MC_TEST_CAPABILITY_PAYLOAD/MC_CANONICAL_ROOT/TOOLSENABLED_SOURCE names ${named}, which has no src/lib, and this worktree has no packed capability/`
      : 'no payload variable is set (MC_TEST_CAPABILITY_PAYLOAD, MC_CANONICAL_ROOT, TOOLSENABLED_SOURCE) and this worktree has no packed capability/',
  }
}

/* SCOPE BY SHAPE, NOT BY WHETHER IT RESOLVES.
 *
 * The first version of this asked "does it resolve in the repository?" and
 * treated everything else as engine-scoped. That is circular: a citation that
 * SHOULD resolve here and does not -- a typo, a renamed file -- looks exactly
 * like an engine citation, and got swept into the payload skip. Mutation C
 * caught it: breaking tools/release-packager/cut-release-candidate.mjs in a
 * reason left the suite green-with-a-skip instead of red.
 *
 * A citation rooted at one of this repository's top-level directories is OURS,
 * whether or not the file is there. Anything else may live in the payload. */
const REPOSITORY_ROOTED = /^(tools|shell|src|config|docs)\//
function isRepositoryScoped(citation) {
  return REPOSITORY_ROOTED.test(citation)
}

function resolvesInProduct(citation) {
  const relative = citation.split('/')
  /* A reason may legitimately cite an ENGINE file -- registry-write.js and
   * provider-session-isolation.js live in the payload, not this repository -- so
   * the engine checkout the run is measuring is searched too, reached the same
   * way every other suite reaches it. In a cut both variables are set by
   * buildDistChainEnvironment; in a bare checkout with neither set and no packed
   * payload, an engine citation cannot be resolved and the assertion says which
   * one rather than passing. */
  const engine = process.env.MC_TEST_CAPABILITY_PAYLOAD || process.env.MC_CANONICAL_ROOT || process.env.TOOLSENABLED_SOURCE
  const roots = [REPO_ROOT, path.join(REPO_ROOT, 'capability'), path.join(REPO_ROOT, 'capability', 'src', 'lib'),
    path.join(REPO_ROOT, 'tools'), path.join(REPO_ROOT, 'shell'), path.join(REPO_ROOT, 'src', 'lib'),
    ...(engine ? [engine, path.join(engine, 'src', 'lib'), path.join(engine, 'tools')] : [])]
  for (const root of roots) if (fs.existsSync(path.join(root, ...relative))) return true
  /* THE LEAF-ONLY WALK IS FOR BARE FILENAMES, AND ONLY THOSE. It exists so a
   * reason may cite "registry-write.js" without knowing which directory holds
   * it. Applied to a citation that HAS a directory it is far too generous: an
   * invented directory with a real filename -- multi-account/audit.js, say --
   * passed, because the walk matched the leaf and ignored everything the author
   * wrote in front of it. A citation that names a path must resolve at that
   * path. */
  if (relative.length > 1) return false
  const leaf = relative[0]
  const walk = (directory, depth) => {
    if (depth > 4) return false
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (entry.isFile() && entry.name === leaf) return true
      if (entry.isDirectory() && walk(path.join(directory, entry.name), depth + 1)) return true
    }
    return false
  }
  const walkRoots = [path.join(REPO_ROOT, 'tools'), path.join(REPO_ROOT, 'shell'),
    path.join(REPO_ROOT, 'capability', 'src'), path.join(REPO_ROOT, 'src'),
    ...(engine ? [path.join(engine, 'src')] : [])]
  return walkRoots.some((root) => walk(root, 0))
}

const SCRATCH = path.join('C:', 'sc', 'state')
const LIVE_ROOT = path.join('C:', 'Users', 'Someone', 'Desktop', 'joshs profile', 'ToolsEnabled-Live')

/** An environment that satisfies the fence: every owned name inside SCRATCH. */
function scratchEnv(overrides = {}) {
  const env = {}
  for (const name of OWNED_NAMES) env[name] = path.join(SCRATCH, name.toLowerCase())
  env.TOOLSENABLED_STATE_ROOT = SCRATCH
  env.MC_TEST_STATE_ROOT = SCRATCH
  return { ...env, ...overrides }
}

/* Hooks every fs and child_process method that could touch the world, for the
 * duration of one call, and reports what was reached. */
function withWorldHooked(run) {
  const touched = []
  const restore = []
  for (const [label, object] of [['fs', fs], ['child_process', childProcess]]) {
    for (const key of Object.keys(object)) {
      const original = object[key]
      if (typeof original !== 'function') continue
      try {
        Object.defineProperty(object, key, {
          configurable: true,
          writable: true,
          value: (...args) => { touched.push(`${label}.${key}`); return original.apply(object, args) },
        })
        restore.push(() => { object[key] = original })
      } catch { /* non-writable property: leave it alone */ }
    }
  }
  try { run() } finally { for (const undo of restore.reverse()) undo() }
  return touched
}

/* WHAT "ZERO CALLS" CAN AND CANNOT MEAN, MEASURED RATHER THAN WISHED FOR.
 *
 * Reading the product's enumerations at run time means loading two .cjs
 * modules, and Node's loader reads files: the hook sees fs.realpathSync and
 * fs.readFileSync on the FIRST call, and fs.openSync/readSync/closeSync for the
 * ESM import of any module at all. A test demanding literally zero fs calls
 * around an import is a test no module can pass, including an empty one -- so
 * asserting it would be asserting nothing, which is the vacuity these
 * replacements exist to remove.
 *
 * The properties that carry the safety are these three, and each is measured:
 *   1. the fence NEVER reaches a mutating or spawning call -- no directory is
 *      created, nothing is written, nothing is executed;
 *   2. once the authorities are cached, a full resolve-and-judge touches fs
 *      zero times, which is what proves the fence's own body does no I/O;
 *   3. the reads that do happen are module loads of the two declared
 *      authorities and nothing else.
 */
const MUTATING_OR_SPAWNING = /^(mkdir|mkdtemp|write|append|rm|rmdir|unlink|copy|rename|truncate|chmod|chown|create(Write|Read)Stream|spawn|exec|fork|execFile)/

test('the fence never reaches a mutating or spawning call', () => {
  const live = scratchEnv({ TOOLSENABLED_VAULT_PATH: path.join(LIVE_ROOT, 'capability', 'vault', 'secrets.json') })
  let refused = false
  const touched = withWorldHooked(() => {
    resolveFencedPaths(live)
    try { assertScratchFence(live, { scratchRoots: [SCRATCH] }) } catch { refused = true }
  })
  assert.ok(refused, 'the live environment must have been refused, or this proves nothing')
  const forbidden = touched.filter((call) => MUTATING_OR_SPAWNING.test(call.split('.')[1]))
  assert.deepEqual(forbidden, [],
    `the fence created, wrote or executed something: ${forbidden.join(', ')}`)
})

test('with the authorities cached, resolve and judge touch fs zero times', () => {
  // The first call loads the two .cjs authorities; Node's loader reads them.
  // Everything after that is the fence's own body, and it must do no I/O at all.
  const live = scratchEnv({ TOOLSENABLED_VAULT_PATH: path.join(LIVE_ROOT, 'capability', 'vault', 'secrets.json') })
  resolveFencedPaths(live)
  try { assertScratchFence(live, { scratchRoots: [SCRATCH] }) } catch { /* expected */ }

  let refused = false
  const touched = withWorldHooked(() => {
    resolveFencedPaths(live)
    try { assertScratchFence(live, { scratchRoots: [SCRATCH] }) } catch { refused = true }
  })
  assert.ok(refused, 'still a live environment, still refused')
  assert.deepEqual(touched, [],
    `the fence's own body reached: ${touched.join(', ')}`)
})

test('the only files the fence ever reads are its two declared authorities', () => {
  const read = []
  const originalReadFile = fs.readFileSync
  const originalRealpath = fs.realpathSync
  fs.readFileSync = (file, ...rest) => { read.push(String(file)); return originalReadFile(file, ...rest) }
  fs.realpathSync = (file, ...rest) => { read.push(String(file)); return originalRealpath(file, ...rest) }
  try {
    // A fresh require cache is not available here, so this asserts the shape of
    // what is reachable: only the two authority modules are named.
    readAuthorities({ load: (specifier) => { read.push(specifier); return createRequire(import.meta.url)(specifier) } })
  } finally {
    fs.readFileSync = originalReadFile
    fs.realpathSync = originalRealpath
  }
  const offenders = read.filter((file) => !/capability-path-environment\.cjs|install-profile-guard\.cjs/.test(file))
  assert.deepEqual(offenders, [], `the fence reached files beyond its authorities: ${offenders.join(', ')}`)
})

test('importing the module executes nothing of its own', async () => {
  const touched = []
  const restore = []
  for (const [label, object] of [['fs', fs], ['child_process', childProcess]]) {
    for (const key of Object.keys(object)) {
      const original = object[key]
      if (typeof original !== 'function') continue
      try {
        Object.defineProperty(object, key, {
          configurable: true, writable: true,
          value: (...args) => { touched.push(`${label}.${key}`); return original.apply(object, args) },
        })
        restore.push(() => { object[key] = original })
      } catch { /* skip */ }
    }
  }
  try {
    // Fresh module instance, so this measures IMPORT and not a cached one.
    await import(`../lib/scratch-fence.mjs?purity=${Date.now()}`)
  } finally { for (const undo of restore.reverse()) undo() }
  // Reading the module's own bytes is the ESM loader and unavoidable for any
  // module; what must not appear is anything the module BODY did -- a mutating
  // call, a spawn, or a read of some other file.
  const forbidden = touched.filter((call) => MUTATING_OR_SPAWNING.test(call.split('.')[1]))
  assert.deepEqual(forbidden, [], `importing the fence executed: ${forbidden.join(', ')}`)
  const unexpected = touched.filter((call) => !/^fs\.(openSync|readSync|closeSync|fstatSync|statSync|realpathSync|readFileSync)$/.test(call))
  assert.deepEqual(unexpected, [], `importing the fence reached beyond the loader: ${unexpected.join(', ')}`)
})

test('the fence is a function of the environment it is handed, never process.env', () => {
  // Worker 87's exact defect: a safe environment handed in, live values still
  // ambient. Every resolved path must be the scratch one.
  const savedState = process.env.TOOLSENABLED_STATE_ROOT
  const savedVault = process.env.TOOLSENABLED_VAULT_PATH
  process.env.TOOLSENABLED_STATE_ROOT = path.join(LIVE_ROOT, 'capability')
  process.env.TOOLSENABLED_VAULT_PATH = path.join(LIVE_ROOT, 'capability', 'vault', 'secrets.json')
  try {
    const entries = resolveFencedPaths(scratchEnv())
    for (const entry of entries) {
      if (entry.resolved === null) continue
      assert.ok(!isLiveInstallationPath(entry.resolved),
        `${entry.label} answered an ambient live value: ${entry.resolved}`)
    }
    assert.doesNotThrow(() => assertScratchFence(scratchEnv(), { scratchRoots: [SCRATCH] }),
      'a safe environment must pass even while the ambient one is live')
  } finally {
    if (savedState === undefined) delete process.env.TOOLSENABLED_STATE_ROOT; else process.env.TOOLSENABLED_STATE_ROOT = savedState
    if (savedVault === undefined) delete process.env.TOOLSENABLED_VAULT_PATH; else process.env.TOOLSENABLED_VAULT_PATH = savedVault
  }
  assert.throws(() => resolveFencedPaths(undefined), /never reads process\.env/,
    'it must refuse rather than quietly fall back to the ambient environment')
})

test('paths are resolved before anything is judged', () => {
  // Ordering, with a loader that throws if the authorities are read late.
  let judged = false
  const loader = (specifier) => {
    assert.equal(judged, false, 'the fence judged before it had finished resolving')
    return createRequire(import.meta.url)(specifier)
  }
  const entries = resolveFencedPaths(scratchEnv(), { load: loader })
  judged = true
  assert.ok(entries.length > 0)
})

test('each authority refuses in its own name when it goes quiet', () => {
  const real = createRequire(import.meta.url)
  const categories = ['capability overrides', 'account paths', 'provider homes']
  for (const category of categories) {
    const starved = (specifier) => {
      const loaded = real(specifier)
      const group = readAuthoritiesFor(category)
      return { ...loaded, [group.exportName]: [] }
    }
    assert.throws(
      () => requiredNames({ load: starved }),
      (error) => {
        assert.match(error.message, new RegExp(category), `starving "${category}" must name that category`)
        assert.match(error.message, /floor|could not read/, 'and say it refused rather than read an empty category')
        return true
      },
      `starving ${category}`,
    )
  }
})

function readAuthoritiesFor(category) {
  return {
    'capability overrides': { exportName: 'CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES' },
    'account paths': { exportName: 'STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES' },
    'provider homes': { exportName: 'PROVIDER_HOME_ENVIRONMENT_NAMES' },
  }[category]
}

test('the set comes from the product authorities, by category, with no total written down', () => {
  const { groups, names } = requiredNames()
  assert.deepEqual(groups.map((group) => group.category),
    ['capability overrides', 'account paths', 'provider homes', 'node loader', 'test harness seam'])
  // Floors from the rule above, not from the groups being measured. A total is
  // deliberately absent -- that is the number that rots -- but a floor is a
  // decision and belongs written down.
  for (const group of groups) {
    const floor = FLOOR_BY_RULE[group.category]
    if (floor === undefined) continue
    assert.ok(group.names.length >= floor,
      `${group.category} must carry at least ${floor} names; got ${group.names.length}`)
  }

  // THE OWNED SET IS A DECISION, SO IT IS WRITTEN DOWN. Deriving it from the
  // fence and asserting the fence matches proves only self-consistency.
  assert.deepEqual([...OWNED_NAMES].sort(), OWNED_BY_RULE,
    'the names a run must own are the ones the rule names')
  for (const name of CAPABILITY_MUST_INCLUDE) {
    assert.ok(groups[0].names.includes(name),
      `the capability authority must still carry ${name}; a scrub that lost it is not a fence`)
  }
  assert.deepEqual(groups[4].names, ['MC_TEST_STATE_ROOT'], 'exactly one declared seam')

  // The safety-class name Worker 89 found missing, and the harness seam.
  assert.ok(names.includes('TOOLSENABLED_STATE_PATH'), 'the grant store must be fenced')
  assert.ok(names.includes('MC_TEST_STATE_ROOT'))
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) assert.ok(names.includes(name), name)

  // The audit database is found by SHAPE, not by literal.
  assert.deepEqual(auditDatabaseNames(names), ['TOOLSENABLED_AUDIT_DB'])
  for (const bare of ['AUDIT_JSONL', 'AUDIT_TEXT', 'AUDIT_EMERGENCY']) {
    assert.ok(!names.includes(bare), `${bare} is not one of the enumeration's names`)
  }
})

test('eight spellings of one live path are all refused by name', () => {
  const tail = ['capability', 'vault', 'secrets.json']
  const backslash = path.join(LIVE_ROOT, ...tail)
  const forward = backslash.split(path.sep).join('/')
  const spellings = {
    'lower backslash': backslash,
    'upper backslash': backslash.toUpperCase(),
    'mixed backslash': backslash.replace('ToolsEnabled-Live', 'toolsENABLED-live'),
    'lower forward': forward,
    'upper forward': forward.toUpperCase(),
    'msys': '/c/Users/Someone/Desktop/joshs profile/ToolsEnabled-Live/capability/vault/secrets.json',
    'msys upper': '/C/USERS/SOMEONE/DESKTOP/JOSHS PROFILE/TOOLSENABLED-LIVE/CAPABILITY/VAULT/SECRETS.JSON',
    'trailing separator': `${path.join(LIVE_ROOT, 'capability')}${path.sep}`,
  }
  for (const [label, spelling] of Object.entries(spellings)) {
    assert.ok(isLiveInstallationPath(spelling), `${label} must read as live`)
    let message = ''
    try { assertScratchFence(scratchEnv({ TOOLSENABLED_VAULT_PATH: spelling }), { scratchRoots: [SCRATCH] }) } catch (error) { message = error.message }
    assert.match(message, /TOOLSENABLED_VAULT_PATH/, `${label} must name the variable`)
    assert.match(message, /resolves inside a live installation/, `${label} must refuse for the live reason`)
  }
})

test('unset and empty both refuse for an owned name', () => {
  for (const blank of [undefined, '', '   ']) {
    const env = scratchEnv({ TOOLSENABLED_STATE_PATH: blank })
    assert.throws(
      () => assertScratchFence(env, { scratchRoots: [SCRATCH] }),
      (error) => {
        assert.match(error.message, /TOOLSENABLED_STATE_PATH is unset or empty/, `${JSON.stringify(blank)} must refuse`)
        assert.match(error.message, /picks its own default/, 'and say why absence is not safety')
        return true
      },
    )
  }
})

test('a capability override may be unset, but not set outside the scratch', () => {
  // Their defaults derive from the fenced state root, so absence is already
  // inside the fence; a value is not.
  assert.doesNotThrow(() => assertScratchFence(scratchEnv(), { scratchRoots: [SCRATCH] }))
  assert.throws(
    () => assertScratchFence(scratchEnv({ TOOLSENABLED_RESEARCH_DB: path.join('C:', 'elsewhere', 'research.sqlite3') }), { scratchRoots: [SCRATCH] }),
    /TOOLSENABLED_RESEARCH_DB resolves outside this run's scratch/,
    'set means contained, whatever the category',
  )
})

test('USERPROFILE and HOME are held to the not-live rule only, and that is measured', () => {
  // The product only READS them: homeDir in codex-cloud-environments.js,
  // codex-cloud-launch.js and mission-bridge/actions.js, no write through.
  assert.deepEqual([...ACCOUNT_IDENTITY_NAMES], ['USERPROFILE', 'HOME'])
  assert.doesNotThrow(
    () => assertScratchFence(scratchEnv({ USERPROFILE: path.join('C:', 'Users', 'Someone'), HOME: path.join('C:', 'Users', 'Someone') }), { scratchRoots: [SCRATCH] }),
    'the real account home is where these legitimately point',
  )
  assert.throws(
    () => assertScratchFence(scratchEnv({ USERPROFILE: path.join(LIVE_ROOT, 'profile') }), { scratchRoots: [SCRATCH] }),
    /USERPROFILE resolves inside a live installation/,
    'exempt from containment is not exempt from the live rule',
  )
})

test('the derived audit paths follow the state root, and an unresolvable one refuses', () => {
  const entries = resolveFencedPaths(scratchEnv())
  const ledger = entries.find((entry) => entry.derived && entry.label.includes('audit ledger'))
  assert.ok(ledger, 'the ledger is derived when no variable names it')
  assert.equal(ledger.resolved, path.join(SCRATCH, 'state', 'audit.sqlite3'))
  assert.throws(
    () => assertScratchFence({ ...scratchEnv(), TOOLSENABLED_STATE_ROOT: '' }, { scratchRoots: [SCRATCH] }),
    /audit ledger/,
    'an unresolved derived path is not a safe path',
  )
})

test('the clean scratch environment passes', () => {
  const entries = assertScratchFence(scratchEnv(), { scratchRoots: [SCRATCH] })
  assert.ok(entries.length > 0)
  assert.ok(isInside(SCRATCH, path.join(SCRATCH, 'vault')))
  assert.ok(!isInside(SCRATCH, path.join('C:', 'sc', 'other')))
  assert.equal(LIVE_INSTALLATION_SEGMENT, 'ToolsEnabled-Live')
})

test('no name can join the containment-exempt tier without its own measured reason', () => {
  // THE SHAPE, not just the membership. "The product only reads these" was
  // written once, measured false later, and would have silently covered any
  // name that landed in the tier afterwards. Keying the tier by name with a
  // reason each makes that impossible without writing a new one.
  const exempt = Object.keys(CONTAINMENT_EXEMPT_REASONS)
  // Anchored to the rule written at the top of this file, NOT to the fence's
  // own constants. Comparing it against ACCOUNT_IDENTITY_NAMES +
  // NODE_LOADER_NAMES -- which is what it did -- took both sides from the thing
  // under test, so dropping a name from the tier and from those constants left
  // it green.
  assert.deepEqual(exempt.slice().sort(), CONTAINMENT_EXEMPT_BY_RULE,
    'the tier is exactly the four names the rule exempts')
  // The fence's own two constants must still add up to it, which is now a
  // check of the fence against the rule rather than against itself.
  assert.deepEqual([...ACCOUNT_IDENTITY_NAMES, ...NODE_LOADER_NAMES].sort(), CONTAINMENT_EXEMPT_BY_RULE)
  // Every reason must CITE something; whether each citation resolves is the
  // next test, because that one needs the engine payload and this one does not.
  for (const [name, reason] of Object.entries(CONTAINMENT_EXEMPT_REASONS)) {
    assert.equal(typeof reason, 'string')
    assert.ok(citationsIn(reason).length > 0,
      `${name}'s reason must cite at least one file, not just describe a conclusion`)
  }
  // And the tier is exempt from CONTAINMENT only -- never from the live rule.
  for (const name of exempt) {
    assert.throws(
      () => assertScratchFence(scratchEnv({ [name]: path.join(LIVE_ROOT, 'anything') }), { scratchRoots: [SCRATCH] }),
      new RegExp(`${name} resolves inside a live installation`),
      `${name} is exempt from containment, not from the live rule`,
    )
  }
})

test('every citation in an exemption reason resolves to a real file', (t) => {
  /* SPLIT OUT OF THE TIER TEST ON PURPOSE. This one needs the engine payload;
   * the tier's shape does not. Keeping them together made a fresh clone run the
   * whole check red for an environment reason -- 14 of 15 in a bare worktree,
   * 15 of 15 in the assembly worktree -- and a suite that reds for the
   * environment is a suite the next reader learns to discount.
   *
   * Reachable: every citation must resolve, and one that does not fails BY NAME.
   * Unreachable: skip BY NAME saying what was missing. In a cut the payload
   * variables are set, so this runs fully there, which is where it matters. */
  const local = []
  const engineScoped = []
  for (const [name, reason] of Object.entries(CONTAINMENT_EXEMPT_REASONS)) {
    for (const citation of citationsIn(reason)) {
      (isRepositoryScoped(citation) ? local : engineScoped).push({ name, citation })
    }
  }

  // Citations rooted in this repository are checked whatever the payload is
  // doing, so an unreachable payload can never mask a local mistake -- which is
  // exactly what a resolve-based split did until a mutation caught it.
  for (const { name, citation } of local) {
    assert.ok(resolvesInProduct(citation), `${name}'s reason cites ${citation}, which does not resolve`)
  }

  const payload = enginePayloadReachable()
  if (!payload.reachable && engineScoped.length > 0) {
    t.skip(`${engineScoped.length} citation(s) name engine files and the payload was NOT inspected: `
      + `${engineScoped.map((entry) => `${entry.name} -> ${entry.citation}`).join('; ')}. `
      + `${payload.why}. That is "could not look", not "the citation is good" -- a cut sets these and runs the check.`)
    return
  }
  for (const { name, citation } of engineScoped) {
    assert.ok(resolvesInProduct(citation),
      `${name}'s reason cites ${citation}, which resolves to no file in this repository or in the payload (${payload.how})`)
  }
})

test('a name missing from the handed environment resolves to nothing, never to the ambient value', (t) => {
  /* THE DIRECTION THE OVERRIDE CASE CANNOT REACH. Test 5 hands a COMPLETE
   * environment, so a resolver that consulted process.env only when the handed
   * object lacked a name would keep this suite fully green -- the override
   * always wins when there is something to override. Worker 89 drove exactly
   * that mutation and saw 15 of 15 pass.
   *
   * So: delete one owned name from the handed environment while the LIVE value
   * for it is ambient, and require that entry to resolve to nothing. A fallback
   * would answer the owner's real path here. */
  const name = 'TOOLSENABLED_VAULT_PATH'
  const livePath = path.join(LIVE_ROOT, 'capability', 'vault', 'secrets.json')
  const saved = process.env[name]
  process.env[name] = livePath
  try {
    const handed = scratchEnv()
    delete handed[name]
    const entry = resolveFencedPaths(handed).find((candidate) => candidate.name === name && !candidate.derived)
    assert.ok(entry, `${name} must still be enumerated even when the handed environment omits it`)
    assert.equal(entry.resolved, null,
      `${name} was absent from the handed environment and must resolve to nothing; it resolved to ${entry.resolved}`)
    assert.notEqual(entry.resolved, path.resolve(livePath), 'and never to the ambient live value')

    // And the fence still refuses, for absence rather than for a live path --
    // so the missing name is reported as missing, not quietly satisfied.
    let message = ''
    try { assertScratchFence(handed, { scratchRoots: [SCRATCH] }) } catch (error) { message = error.message }
    assert.match(message, new RegExp(`${name} is unset or empty`),
      `the refusal must name the absence; got: ${message}`)
    assert.ok(!message.includes(LIVE_ROOT),
      'and must not mention the ambient live path, which the fence never read')
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved
  }
})
