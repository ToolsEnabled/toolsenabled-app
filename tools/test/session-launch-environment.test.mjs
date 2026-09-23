// WHOSE ACCOUNT DOES THE AGENT TOOLSENABLED STARTS ACTUALLY SPEND?
//
// Until this suite, shell/agent-host.cjs handed its agent child the user's
// ENTIRE environment, by both of its branches and with nothing removed:
//
//   at `unrestricted`   no `env` key was passed at all -- and codex-process.js
//                       does `env === undefined ? process.env : env`, so the
//                       omission handed over the whole parent environment
//   at every other level `{ ...process.env, ...plan.env }` -- the whole parent
//                       environment again, plus CODEX_HOME
//
// The level that got the LEAST protection was the default one, and the branch
// that looked like "we pass nothing" was the branch that passed everything.
// That asymmetry was the defect, so every case below is asserted at BOTH
// levels; a fix covering one of them is the bug with a smaller blast radius.
//
// WHAT IS AT STAKE, in two kinds, kept apart on purpose:
//
//   BILLING     ANTHROPIC_API_KEY is set on the build machine and persisted in
//               HKCU:\Environment, so every process the owner starts inherits
//               it. Claude Code gives it PRECEDENCE over the Max subscription
//               login, and this agent session can spawn a Claude CLI. That is
//               the recorded R1186 outage: hours billed to a drained API
//               account while `claude auth status` reported a perfect green.
//   REDIRECTION OPENAI_BASE_URL / ANTHROPIC_BASE_URL carry no credential and
//               take the session's prompts and file contents to an arbitrary
//               host. The session starts, answers, and looks correct. There is
//               no failure for anyone to notice.
//
// THESE ASSERTIONS ARE BEHAVIOURAL, on the options object the engine was
// actually handed, driven through the host's real resolution path -- engine
// root, hostModule lookup, safeLaunchEnvironment. A source-text assertion that
// a scrub is written still passes when the caller stopped routing through it,
// and that is exactly how a scrub ships bypassed.
//
// Every poisoned variable is set to a value that would be ACTIVELY HARMFUL if
// inherited, and each fixture asserts it really set the variable, so a pass
// means the value was REMOVED rather than absent on this machine.
//
// SCOPE, STATED SO A GREEN RUN IS NOT READ AS MORE THAN IT IS: the fixture
// engine's scrub module is a routing stand-in with a deliberately small sample
// list (see its header). The authoritative list lives in exactly one place --
// src/lib/providers/subscription-launch-env.js, composed by folding the
// provider gateway's own providerEnvironment() over every provider -- and is
// tested there. What this suite pins is that the host ROUTES through that
// module, at every level, and refuses to start when it cannot.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { countEnvironmentKeys, readEnvironmentVariable } from './lib/windows-environment.mjs'
/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const { createAgentHost, engineAvailability } = require(path.join(ROOT, 'shell/agent-host.cjs'))

const FIXTURES = path.join(ROOT, 'tools/test/fixtures')
const CONFINED_ENGINE = path.join(FIXTURES, 'confined-engine/src/lib/agent-engine/codex-process.js')
const NO_SCRUB_ENGINE = path.join(FIXTURES, 'no-scrub-engine/src/lib/agent-engine/codex-process.js')
const UNRECOGNIZED_SCRUB_ENGINE = path.join(FIXTURES, 'unrecognized-scrub-engine/src/lib/agent-engine/codex-process.js')
const STAGED_PLANNER = path.join(ROOT, 'capability', 'src', 'lib', 'agent-session-confinement.js')
const STAGED_LAUNCH_ENVIRONMENT = path.join(ROOT, 'capability', 'src', 'lib', 'providers', 'subscription-launch-env.js')
// Keep the real-planner fixture off node_modules: workspace builds may link it,
// and the production path fence must continue refusing reparse-point traversal.
const TEST_ARTIFACTS = path.join(ROOT, 'artifacts')
mkdirSync(TEST_ARTIFACTS, { recursive: true })
const TEST_SCRATCH_ROOT = mkdtempSync(path.join(TEST_ARTIFACTS, 'launch-environment-'))
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

// Each name is poisoned with a value that would do real damage if it survived,
// and each is a DIFFERENT kind of harm so that a fix addressing only one shape
// cannot pass. These are the fixture stand-in's sample list; see this file's
// header for why the authoritative list is not duplicated here.
const POISONED = Object.freeze({
  ANTHROPIC_API_KEY: {
    value: 'sk-ant-fixture-would-bill-a-metered-account',
    harm: 'takes precedence over the owner subscription login, so the session bills a metered API account',
  },
  OPENAI_API_KEY: {
    value: 'sk-fixture-another-providers-metered-key',
    harm: "belongs to a DIFFERENT provider than the one being launched -- a per-provider scrub misses it, which is why the launch takes a union",
  },
  OPENAI_BASE_URL: {
    value: 'https://attacker.invalid/v1',
    harm: "carries no credential and redirects the session's prompts and file contents to an arbitrary host, while the session still works",
  },
})

const INSTALLATION_PROFILE = require(path.join(FIXTURES, 'confined-engine/src/lib/agent-session-confinement.js')).installationProfileRoot()
const UNRESTRICTED_PLAN = Object.freeze({
  ok: true, tier: 'unrestricted', isolated: true,
  threadOptions: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
  env: Object.freeze({
    USERPROFILE: INSTALLATION_PROFILE,
    HOME: INSTALLATION_PROFILE,
    CODEX_HOME: path.join(INSTALLATION_PROFILE, '.codex'),
  }),
})

function confinedPlan(workdir) {
  return {
    ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
  }
}

function withPlan(plan, run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(plan)
  try { return run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  }
}

// Sets the poisoned variables AND proves it set them. Without that proof an
// "it is gone" assertion is satisfied by a machine where it was never there,
// which is a test that passes for the wrong reason on every CI box.
function withPoisonedEnvironment(run) {
  const extra = { MC_LAUNCH_ENV_FIXTURE_KEEP: 'must-survive' }
  const overrides = { ...extra }
  for (const [name, { value }] of Object.entries(POISONED)) overrides[name] = value

  const saved = new Map()
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined)
    process.env[name] = value
  }
  try {
    for (const [name, { value }] of Object.entries(POISONED)) {
      assert.equal(process.env[name], value,
        `the fixture failed to set ${name}, so every "it was removed" assertion in this test would prove nothing`)
    }
    return run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function engineCalls() {
  return require(CONFINED_ENGINE).calls
}

function scrubCalls() {
  return require(path.join(FIXTURES, 'confined-engine/src/lib/providers/subscription-launch-env.js')).calls
}

async function startAndCapture(plan, sessionId) {
  const workdir = testScratch('mc-launch-env-')
  try {
    return await withPlan(plan, async () => await withPoisonedEnvironment(async () => {
      const before = engineCalls().length
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      const started = await host.startSession({ sessionId })
      const call = engineCalls()[before]
      await host.closeAll()
      return { call, started, workdir }
    }))
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

/* ---------- the scrub reaches the child, at BOTH levels ---------- */

for (const [label, makePlan] of [
  ['unrestricted', () => UNRESTRICTED_PLAN],
  ['a confined level', (workdir) => confinedPlan(workdir)],
]) {
  test(`no billing credential or endpoint redirector reaches the agent child at ${label}`, async () => {
    const workdir = testScratch('mc-launch-env-plan-')
    try {
      const plan = makePlan(workdir)
      const { call } = await startAndCapture(plan, `env-${label.replace(/\s+/g, '-')}`)

      // The branch that used to pass NOTHING is the branch that passed
      // everything, because codex-process.js falls back to process.env when
      // `env` is undefined. So the key must exist before its contents matter.
      assert.ok(Object.hasOwn(call, 'env'),
        `at ${label} the host passed no env key, so codex-process.js falls back to the FULL process.env -- the omission is the leak, not the protection`)

      for (const [name, { harm }] of Object.entries(POISONED)) {
        assert.equal(Object.hasOwn(call.env, name), false,
          `${name} survived into the agent child's environment at ${label} -- it ${harm}`)
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  test(`unrelated inherited variables still pass through at ${label}`, async () => {
    // A scrub that takes away a capability is a different bug, not a safer one.
    // Stripping PATH or APPDATA would break the very resolution that finds
    // codex on Windows, so removal must be by NAME and never by pattern.
    const workdir = testScratch('mc-launch-env-keep-')
    try {
      const { call } = await startAndCapture(makePlan(workdir), `keep-${label.replace(/\s+/g, '-')}`)
      assert.equal(call.env.MC_LAUNCH_ENV_FIXTURE_KEEP, 'must-survive',
        `an unrelated variable was dropped at ${label}: the scrub is filtering rather than removing a named list`)

      // WINDOWS ENV KEYS ARE CASE-INSENSITIVE; A SPREAD COPY'S KEYS ARE NOT.
      // `call.env` is a plain object -- the scrub returns `{ ...baseEnvironment }`
      // -- and on this host the underlying key is literally lowercase `path`.
      // So `call.env.PATH` is undefined while `process.env.PATH` resolves
      // through Node's case-insensitive host proxy, and the comparison this
      // assertion used to make (`call.env.PATH === process.env.PATH`) was FALSE
      // on every run regardless of what the product did. A guard that is red
      // unconditionally cannot report the regression it exists for. Measured
      // and explained in tools/test/lib/windows-environment.mjs.
      //
      // Fail closed before comparing: with no PATH in the parent, both sides
      // would be undefined and the equality below would pass proving nothing.
      assert.equal(
        typeof process.env.PATH === 'string' && process.env.PATH.length > 0, true,
        'the parent process has no PATH, so the pass-through assertion below would be satisfied by two undefineds and prove nothing')
      assert.equal(countEnvironmentKeys(call.env, 'PATH'), 1,
        `the child environment at ${label} does not carry exactly one PATH key. Zero means the scrub REMOVED it, which breaks the executable resolution that finds codex on Windows; more than one means the scrub emitted case-variant duplicates and which value the child resolves is then unspecified`)
      // Compared as a boolean on purpose: a value comparison prints both PATHs
      // on failure, and this machine's PATH is full of the owner's home
      // directory. Same rule as the credential assertions -- no values in logs.
      assert.equal(readEnvironmentVariable(call.env, 'PATH') === process.env.PATH, true,
        `PATH was altered at ${label}, which breaks the executable resolution that finds codex on Windows`)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
}

test('the parent environment is what gets scrubbed, not something already replaced', async () => {
  // Proves the host hands process.env INTO the module rather than scrubbing a
  // copy it had already built (or building one and scrubbing nothing). Without
  // this, a host that passed `{}` to the scrub and process.env to the child
  // would satisfy every removal assertion above.
  //
  // Asserted on NAMES and on object IDENTITY, never on a value. The first
  // version of this test compared the credential's value and printed the build
  // machine's REAL ANTHROPIC_API_KEY into the test log when it failed. Names
  // only is the rule the authoritative module already states for its own
  // refusals, and it applies just as much to a test.
  const before = scrubCalls().length
  await startAndCapture(UNRESTRICTED_PLAN, 'scrub-input')
  const call = scrubCalls()[before]
  assert.ok(call, 'the host never called safeLaunchEnvironment(), so nothing was scrubbed')
  assert.equal(call.isLiveProcessEnv, true,
    'the host scrubbed some other object than the live process.env the child inherits -- a scrub of a copy nobody passes on protects nothing')
  assert.equal(call.names.includes('ANTHROPIC_API_KEY'), true,
    'the environment handed to the scrub did not contain the credential under test, so the removal assertions elsewhere in this file would prove nothing')
  assert.equal(typeof call.context === 'string' && call.context.length > 0, true,
    'the scrub was called without a context, so a refusal could not say which launch it refused')
  assert.equal(call.context.includes('scrub-input'), false,
    'the context carries the session id into an error message; caller data has no business in one (BLOCKER 2)')
})

/* ---------- unrestricted reach does not mean another account's profile ---------- */

test('unrestricted keeps full machine reach while using the installation account profile', async () => {
  // Permission level governs machine reach. It does not grant permission to
  // inherit another Windows account's directives, credentials or MCP config.
  // The engine's plan therefore pins the installation-owned home even at the
  // widest sandbox, and the shell must preserve both decisions.
  const saved = Object.hasOwn(process.env, 'CODEX_HOME') ? process.env.CODEX_HOME : undefined
  delete process.env.CODEX_HOME
  try {
    const { call, started } = await startAndCapture(UNRESTRICTED_PLAN, 'unrestricted-home')
    assert.equal(started.tier, 'unrestricted')
    assert.equal(call.threadOptions.sandbox, 'danger-full-access',
      'unrestricted must still ask the engine for the sandbox its own level implies')
    assert.equal(call.env.CODEX_HOME, UNRESTRICTED_PLAN.env.CODEX_HOME,
      'unrestricted lost the installation-owned Codex home and could inherit another account\'s directives')
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  }
})

test("an ambient CODEX_HOME cannot override the installation account at unrestricted", async () => {
  // CODEX_HOME itself is not a billing secret, so the billing scrub leaves it
  // alone. The account plan sits above the scrub and must still replace it:
  // unrestricted is a reach choice, not permission to cross user profiles.
  const saved = Object.hasOwn(process.env, 'CODEX_HOME') ? process.env.CODEX_HOME : undefined
  process.env.CODEX_HOME = path.join(TEST_SCRATCH_ROOT, 'the-users-own-codex-home')
  try {
    const own = path.join(TEST_SCRATCH_ROOT, 'the-users-own-codex-home')
    assert.equal(process.env.CODEX_HOME === own, true,
      'the fixture failed to set CODEX_HOME, so the assertion below would prove nothing')
    const { call } = await startAndCapture(UNRESTRICTED_PLAN, 'users-codex-home')
    assert.equal(call.env.CODEX_HOME, UNRESTRICTED_PLAN.env.CODEX_HOME,
      'the ambient Codex home overrode the installation account pin')
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  }
})

test('a confined level still gets the home that keeps the user MCP servers out', async () => {
  const workdir = testScratch('mc-launch-env-conf-')
  try {
    const plan = confinedPlan(workdir)
    const { call } = await startAndCapture(plan, 'confined-home')
    assert.equal(call.env.CODEX_HOME === plan.env.CODEX_HOME, true,
      'the confinement pin was lost: scrubbing must happen BEFORE the account pin is applied, not instead of it')
    assert.deepEqual(call.threadOptions, plan.threadOptions,
      'the confined level stopped asking the engine for its own sandbox')
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

/* ---------- the pin cannot put back what the scrub removed ---------- */

test('an account pin that reintroduces a credential refuses the launch', async () => {
  // Order of operations, made observable. The pin is applied AFTER the scrub,
  // so a plan whose env carries a credential would hand it straight to the
  // child unless the merged object is asserted again. This is the check that
  // makes "scrub, pin, re-assert" a sequence rather than a comment.
  const workdir = testScratch('mc-launch-env-pin-')
  try {
    const plan = {
      ok: true, tier: 'guided', isolated: true,
      threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(workdir, 'agent-home'), ANTHROPIC_API_KEY: 'sk-ant-reintroduced-by-the-pin' },
    }
    withPlan(plan, () => withPoisonedEnvironment(() => {
      const before = engineCalls().length
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      assert.throws(
        () => host.startSession({ sessionId: 'pin-reintroduce' }),
        (error) => {
          assert.equal(error.code, 'LAUNCH_BILLING_CREDENTIAL_PRESENT',
            'a pin that reintroduced a billing credential did not produce the refusal code that names it')
          assert.equal(error.message.includes('sk-ant-reintroduced-by-the-pin'), false,
            'the refusal printed the credential VALUE, which is the one thing it must never do')
          return true
        },
        // A bare assert.throws that fails reports only "Missing expected
        // exception", which is indistinguishable from every other one in this
        // file. The message has to say what did not happen.
        'the launch was NOT refused: an account pin reintroduced ANTHROPIC_API_KEY after the scrub and the merged environment was never re-asserted, so the credential went to the child',
      )
      assert.equal(engineCalls().length, before,
        'a session was started despite a billing credential surviving into its environment')
    }))
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

/* ---------- fail closed, both shapes ---------- */

test('an engine carrying no launch-environment module cannot start a session', async () => {
  // Failing OPEN here -- falling back to `{ ...process.env }` because that is
  // "what it did before" -- would hand over a metered API key on exactly the
  // installs where a packaging mistake removed the protection, silently,
  // because a mis-billed session looks identical to a correct one.
  const workdir = testScratch('mc-launch-env-missing-')
  try {
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: NO_SCRUB_ENGINE, defaultCwd: workdir })
      assert.throws(
        () => host.startSession({ sessionId: 'no-scrub' }),
        (error) => {
          assert.equal(error.code, 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE',
            'a payload that cannot scrub billing credentials started a session anyway')
          return true
        },
        'the start was NOT refused: an engine with no launch-environment module started a session anyway, which is the fail-open that hands over a metered API key on exactly the installs a packaging mistake stripped the protection from',
      )
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('a launch-environment module of the wrong shape is refused, not used', async () => {
  // The case a presence check alone gets wrong, and the realistic one: a
  // partial or older payload whose module scrubs but cannot assert. Accepting
  // it would apply the account pin afterwards with nothing left to catch what
  // the pin put back.
  const workdir = testScratch('mc-launch-env-shape-')
  try {
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: UNRECOGNIZED_SCRUB_ENGINE, defaultCwd: workdir })
      assert.throws(
        () => host.startSession({ sessionId: 'bad-shape' }),
        (error) => {
          assert.equal(error.code, 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE',
            'a module missing assertNoBillingCredentials was accepted, so the post-pin re-assert would silently not happen')
          return true
        },
        'the start was NOT refused: a launch-environment module of the wrong shape was accepted as if it could protect the account',
      )
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

/* ---------- the installation-account fence is actually wired ---------- */

test('an explicit engine in a sibling Windows profile is refused before loading', { skip: process.platform !== 'win32' }, () => {
  const foreign = path.join(path.parse(ROOT).root, 'Users', 'foreign-profile-sentinel', 'engine', 'codex-process.js')
  const availability = engineAvailability({ enginePath: foreign, defaultCwd: ROOT })
  assert.deepEqual(availability, { ok: false, code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' })
})

test('a namespaced engine in a sibling Windows profile is refused before loading', { skip: process.platform !== 'win32' }, () => {
  const foreign = path.join(path.parse(ROOT).root, 'Users', 'foreign-profile-sentinel', 'engine', 'codex-process.js')
  const availability = engineAvailability({ enginePath: path.toNamespacedPath(foreign), defaultCwd: ROOT })
  assert.deepEqual(availability, { ok: false, code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' })
})

test('unsupported Windows device and UNC engine paths refuse before access', { skip: process.platform !== 'win32' }, () => {
  for (const enginePath of [
    '\\\\.\\C:\\Users\\foreign-profile-sentinel\\engine\\codex-process.js',
    '\\\\localhost\\c$\\Users\\foreign-profile-sentinel\\engine\\codex-process.js',
    '\\\\?\\UNC\\localhost\\c$\\Users\\foreign-profile-sentinel\\engine\\codex-process.js',
  ]) {
    const availability = engineAvailability({ enginePath, defaultCwd: ROOT })
    assert.deepEqual(availability, { ok: false, code: 'AGENT_CONFINEMENT_PROFILE_PATH_UNREADABLE' })
  }
})

test('the account fence checks cwd before the host performs a filesystem stat', () => {
  // Drive the real constructor and bootstrap normalizer with Windows lexical
  // paths on either OS. Every filesystem operation is a recording stand-in;
  // none of these synthetic profile paths can reach the host filesystem.
  // Previously this supplied /Users/... on Linux, where the Windows bootstrap
  // fence correctly does not apply, and inferred an access order from ENOENT.
  const source = readFileSync(path.join(ROOT, 'shell/agent-host.cjs'), 'utf8')
  const ast = parseAst(source)
  const declarations = ['AgentHostError', 'fail', 'boundedString', 'ordinaryWindowsDrivePath',
    'windowsProfileRootOf', 'bootstrapAccountPath', 'assertBootstrapAccountPath',
    'statAsTheOsWill', 'normalizeCwd', 'createAgentHost'].map(name => {
    const node = ast.body.find(entry => ['FunctionDeclaration', 'ClassDeclaration'].includes(entry.type) && entry.id?.name === name)
    assert.ok(node, `actual host declaration ${name} is required`)
    return source.slice(node.start, node.end)
  })
  const profileRoot = 'C:\\PrecutProfileFixture\\owned'
  const foreign = 'C:\\PrecutProfileFixture\\another\\does-not-exist'
  const access = [], loads = []
  const fsFixture = {
    lstatSync(value) { access.push(['lstat', value]); return { isSymbolicLink: () => false } },
    statSync(value) { access.push(['stat', value]); return { isDirectory: () => true } },
    realpathSync(value) { access.push(['realpath', value]); throw Error('Unexpected link traversal') },
  }
  const context = {
    path: path.win32, fs: fsFixture, process: { platform: 'win32', execPath: profileRoot + '\\node.exe', cwd: () => profileRoot },
    __dirname: profileRoot + '\\app\\shell', os: { freemem: TEST_FREE_MEMORY, userInfo: () => ({ homedir: profileRoot }) },
    loadEngine() { loads.push('engine'); return { engineRoot: profileRoot + '\\engine' } },
    loadConfinementPlanner() { loads.push('planner'); throw Error('Planner was reached after a forbidden cwd') },
    loadRLedger() { throw Error('Unexpected ledger access') },
    loadRulesTurnSnapshot() { throw Error('Unexpected rules reader access') },
    loadOwnerRequestStore() { throw Error('Unexpected request store access') },
    // Default for the constructor's ledgerContinuationLoader (bc6c5ced).
    loadLedgerContinuation() { throw Error('Unexpected ledger continuation access') },
  }
  const host = runInNewContext(`${declarations.join('\n')}\n({ createAgentHost, normalizeCwd })`, context, { timeout: 1000 })
  assert.throws(
    () => host.createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: 'owned engine fixture', defaultCwd: foreign, profileRoot }),
    (error) => {
      assert.equal(error?.code, 'AGENT_CONFINEMENT_FOREIGN_PROFILE', error?.stack)
      return true
    },
    'the constructor must reach its bootstrap refusal before a stat or planner load',
  )
  assert.deepEqual(loads, ['engine'], 'the constructor follows its actual engine-then-cwd ordering')
  assert.deepEqual(access, [], 'neither stat, lstat nor realpath may observe the rejected cwd')
  const owned = profileRoot + '\\work'
  assert.equal(host.normalizeCwd(owned, profileRoot, null, profileRoot), owned)
  assert.deepEqual(access, [['lstat', owned], ['stat', owned]], 'the positive path reaches real normalizer filesystem boundaries')
  // Fault the fence only in memory: the same instrument must now observe the
  // synthetic foreign cwd. No fixture path is ever passed to the real fs.
  const fence = "const bootstrapResolved = assertBootstrapAccountPath(absolute, { field: 'agent cwd', profileRoot })"
  const normalizer = declarations.find(text => text.startsWith('function normalizeCwd('))
  assert.ok(normalizer.includes(fence), 'the normalizer fence must be identifiable for the negative control')
  const unfenced = runInNewContext(`${declarations.filter(text => text !== normalizer).join('\n')}\n${normalizer.replace(fence, 'const bootstrapResolved = absolute')}\nnormalizeCwd`, { ...context }, { timeout: 1000 })
  access.length = 0
  assert.equal(unfenced(foreign, profileRoot, null, profileRoot), foreign)
  assert.deepEqual(access, [['stat', foreign]], 'removing the fence must expose exactly the forbidden stat to this instrument')
})

test('a namespaced sibling-profile cwd is refused before the host performs a filesystem stat', { skip: process.platform !== 'win32' }, () => {
  const foreign = path.join(path.parse(ROOT).root, 'Users', 'foreign-profile-sentinel', 'does-not-exist')
  assert.throws(
    () => createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: path.toNamespacedPath(foreign) }),
    (error) => error?.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE',
    'an extended-length sibling cwd reached the ordinary inaccessible-path error',
  )
})

test('a per-session UNC cwd cannot bypass the bootstrap fence that guarded the default cwd', { skip: process.platform !== 'win32' }, async () => {
  const workdir = testScratch('mc-session-unc-cwd-')
  try {
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      assert.throws(
        () => host.startSession({
          sessionId: 'unc-session-cwd',
          cwd: '\\\\localhost\\c$\\Users\\foreign-profile-alias\\does-not-exist',
        }),
        (error) => error?.code === 'AGENT_CONFINEMENT_PROFILE_PATH_UNREADABLE',
        'a per-session UNC cwd reached the filesystem after the default cwd had passed the bootstrap fence',
      )
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('owned namespaced drive paths are normalized before engine load and cwd use', { skip: process.platform !== 'win32' }, async () => {
  const workdir = testScratch('mc-owned-namespaced-path-')
  try {
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const before = engineCalls().length
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: path.toNamespacedPath(CONFINED_ENGINE),
        defaultCwd: path.toNamespacedPath(workdir),
      })
      await host.startSession({ sessionId: 'owned-namespaced-path' })
      const call = engineCalls()[before]
      assert.ok(call, 'the owned extended-length engine was not loaded')
      assert.equal(path.win32.normalize(call.cwd), path.win32.normalize(workdir))
      assert.equal(call.cwd.startsWith('\\\\?\\'), false, 'the namespaced cwd reached the engine without ordinary-path normalization')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('the account fence checks the final merged environment before an engine starts', async () => {
  const workdir = testScratch('mc-profile-env-')
  const previous = process.env.MC_TEST_FOREIGN_PROFILE_SENTINEL
  try {
    process.env.MC_TEST_FOREIGN_PROFILE_SENTINEL = 'C:\\Users\\foreign-profile-sentinel\\config'
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const before = engineCalls().length
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      assert.throws(
        () => host.startSession({ sessionId: 'foreign-profile-env' }),
        (error) => error?.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT',
      )
      assert.equal(engineCalls().length, before, 'the engine was called after the final environment fence refused')
      await host.closeAll()
    })
  } finally {
    if (previous === undefined) delete process.env.MC_TEST_FOREIGN_PROFILE_SENTINEL
    else process.env.MC_TEST_FOREIGN_PROFILE_SENTINEL = previous
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('the real staged planner permits Windows PUBLIC only because the shell removes it, and still refuses a sibling profile', { skip: process.platform !== 'win32' }, async () => {
  /* Do not prove this with confined-engine's deliberately narrow planner: that
     fixture rejects only MC_TEST_FOREIGN_PROFILE_SENTINEL and is exactly why a
     the normal shared-profile PUBLIC value survived the full suite. This small engine
     root forwards to the REAL staged planner and launch scrub while retaining
     the recording Codex process, so the assertion crosses the production merge
     and tripwire without starting an external program. */
  const engineRoot = testScratch('mc-real-planner-engine-')
  // The fixture is a CommonJS engine, not part of the surrounding ESM app.
  writeFileSync(path.join(engineRoot, 'package.json'), '{"type":"commonjs"}\n')
  const engineModule = path.join(engineRoot, 'src', 'lib', 'agent-engine', 'codex-process.js')
  const plannerModule = path.join(engineRoot, 'src', 'lib', 'agent-session-confinement.js')
  const launchModule = path.join(engineRoot, 'src', 'lib', 'providers', 'subscription-launch-env.js')
  for (const file of [engineModule, plannerModule, launchModule]) mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(engineModule, `'use strict'\nmodule.exports = require(${JSON.stringify(CONFINED_ENGINE)})\n`)
  writeFileSync(plannerModule, `'use strict'\nmodule.exports = require(${JSON.stringify(STAGED_PLANNER)})\n`)
  writeFileSync(launchModule, `'use strict'\nmodule.exports = require(${JSON.stringify(STAGED_LAUNCH_ENVIRONMENT)})\n`)

  const realPlanner = require(STAGED_PLANNER)
  const profileEnv = realPlanner.accountProfileEnvironment()
  const plan = Object.freeze({
    ok: true,
    tier: 'unrestricted',
    isolated: true,
    threadOptions: Object.freeze({ sandbox: 'danger-full-access', approvalPolicy: 'never' }),
    env: Object.freeze({ ...profileEnv, CODEX_HOME: path.join(realPlanner.installationProfileRoot(), '.codex') }),
  })
  const workdir = testScratch('mc-real-planner-work-')

  /* This test process may have been launched by a different account than the
     checkout owner. Remove those unrelated inherited references for the one
     controlled world below, but deliberately retain PUBLIC: it is the normal
     Windows shared-profile variable whose production treatment is under test. */
  const saved = new Map()
  const rememberAndDelete = (name) => {
    if (!saved.has(name)) saved.set(name, process.env[name])
    delete process.env[name]
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase() === 'PUBLIC') continue
    try { realPlanner.assertAccountProfileEnvironment({ [name]: value }) }
    catch (error) {
      if (error?.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT') rememberAndDelete(name)
      else throw error
    }
  }
  for (const name of Object.keys(process.env).filter(name => name.toUpperCase() === 'PUBLIC')) rememberAndDelete(name)
  const sentinelName = 'MC_TEST_REAL_FOREIGN_PROFILE_SENTINEL'
  if (Object.hasOwn(process.env, sentinelName)) rememberAndDelete(sentinelName)
  for (const name of ['TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_VAULT_PATH']) {
    if (Object.hasOwn(process.env, name)) rememberAndDelete(name)
  }

  try {
    process.env.PUBLIC = ['C:', 'Users', 'Public'].join(path.win32.sep)
    process.env.TOOLSENABLED_STATE_ROOT = path.join(workdir, 'state')
    process.env.TOOLSENABLED_VAULT_PATH = path.join(workdir, 'state', 'vault', 'secrets.json')
    const before = engineCalls().length
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
      enginePath: engineModule,
      defaultCwd: workdir,
      confinementPlanner: () => plan,
    })
    try {
      await host.startSession({ sessionId: 'real-planner-public' })
    } catch (error) {
      assert.fail(`the controlled PUBLIC-only launch was refused by ${error?.code || 'an unknown code'}${Array.isArray(error?.details?.variables) ? ` (${error.details.variables.join(', ')})` : ''}`)
    }
    const call = engineCalls()[before]
    assert.ok(call, 'the recording engine was not reached after the shared PUBLIC variable was removed')
    assert.equal(Object.keys(call.env).some(name => name.toUpperCase() === 'PUBLIC'), false,
      'the shared Windows PUBLIC profile pointer reached the agent child')
    await host.closeAll()

    process.env[sentinelName] = ['C:', 'Users', 'foreign-profile-sentinel', 'config'].join(path.win32.sep)
    const refusingHost = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
      enginePath: engineModule,
      defaultCwd: workdir,
      confinementPlanner: () => plan,
    })
    assert.throws(
      () => refusingHost.startSession({ sessionId: 'real-planner-foreign' }),
      (error) => error?.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT',
      'removing PUBLIC widened the account fence to another sibling-profile environment value',
    )
    await refusingHost.closeAll()
  } finally {
    delete process.env.PUBLIC
    delete process.env[sentinelName]
    delete process.env.TOOLSENABLED_STATE_ROOT
    delete process.env.TOOLSENABLED_VAULT_PATH
    for (const [name, value] of saved) process.env[name] = value
    rmSync(workdir, { recursive: true, force: true })
    rmSync(engineRoot, { recursive: true, force: true })
  }
})

test('a resumed thread cannot return a foreign-profile cwd into the live session', async () => {
  const workdir = testScratch('mc-profile-resume-')
  const previous = process.env.MC_TEST_RESUMED_THREAD_CWD
  try {
    process.env.MC_TEST_RESUMED_THREAD_CWD = 'C:\\Users\\foreign-profile-sentinel\\workspace'
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      await assert.rejects(
        host.startSession({ sessionId: 'foreign-profile-resume', resumeThreadId: 'thread-existing' }),
        (error) => error?.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE',
      )
      await host.closeAll()
    })
  } finally {
    if (previous === undefined) delete process.env.MC_TEST_RESUMED_THREAD_CWD
    else process.env.MC_TEST_RESUMED_THREAD_CWD = previous
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('a resumed thread cannot return a UNC cwd around the installation-account fence', { skip: process.platform !== 'win32' }, async () => {
  const workdir = testScratch('mc-profile-resume-unc-')
  const previous = process.env.MC_TEST_RESUMED_THREAD_CWD
  try {
    process.env.MC_TEST_RESUMED_THREAD_CWD = '\\\\localhost\\c$\\Users\\foreign-profile-alias\\workspace'
    await withPlan(UNRESTRICTED_PLAN, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      await assert.rejects(
        host.startSession({ sessionId: 'foreign-profile-resume-unc', resumeThreadId: 'thread-existing' }),
        (error) => error?.code === 'AGENT_CONFINEMENT_PROFILE_PATH_UNREADABLE',
      )
      await host.closeAll()
    })
  } finally {
    if (previous === undefined) delete process.env.MC_TEST_RESUMED_THREAD_CWD
    else process.env.MC_TEST_RESUMED_THREAD_CWD = previous
    rmSync(workdir, { recursive: true, force: true })
  }
})

/* ---------- what a customer actually receives ---------- */

test('the launch-environment module is staged in the payload the installer ships', () => {
  // agent-host.cjs resolves it out of the capability payload at runtime, and
  // tools/check-asar-manifest.mjs gates every hostModules entry against the
  // built package. Undeclared, it reaches the payload only as an incidental
  // dependency of src/lib/mission-bridge/actions.js -- so the day that require
  // is removed, every shipped copy would refuse to start an agent, with the
  // cause three modules away from the symptom.
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'tools/capability-manifest.json'), 'utf8'))
  assert.ok(
    manifest.hostModules.includes('src/lib/providers/subscription-launch-env.js'),
    'the launch-environment module must be declared as a hostModule, or nothing verifies it reached the built package',
  )
})

test('the host names the real module, so a customer cannot be running a test stand-in', () => {
  // The fixture used above is a routing stand-in with a deliberately small
  // sample list. This is what keeps that fact harmless: production resolves the
  // authoritative module, whose list is composed from the provider gateway
  // rather than hand-written, by exactly this path.
  const source = readFileSync(path.join(ROOT, 'shell/agent-host.cjs'), 'utf8')
  assert.match(
    source,
    /PAYLOAD_LAUNCH_ENVIRONMENT_MODULE = 'src\/lib\/providers\/subscription-launch-env\.js'/,
    'the host no longer resolves the authoritative launch-environment module by its real path',
  )
})
