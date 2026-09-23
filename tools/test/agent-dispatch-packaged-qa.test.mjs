import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  copyReleasePayloadForMeasurement,
  dispatchCoverage,
  dispatchAttemptStage,
  dispatchOutcomeAllowed,
  expectedLaunchAttempts,
  optionalFileContents,
  payloadManifestStatus,
  providerlessEnvironment,
  providerFreeObjectivesCompleted,
  shouldAbortRemainingDispatches,
} from '../agent-dispatch-packaged-qa.mjs'
import {
  providerFreeCompletionCount,
  redirectLocalRuntimePorts,
  waitForProviderFreeCompletion,
} from '../lib/provider-free-local-runtime.mjs'

const ORIGINAL_RUNTIME_PORTS = [11434, 1234, 8080, 8000]

function releasePayloadFixture(root) {
  const payload = path.join(root, 'resources', 'capability')
  const providers = path.join(payload, 'src', 'lib', 'providers')
  mkdirSync(providers, { recursive: true })
  writeFileSync(path.join(payload, 'PAYLOAD.json'), '{}\n')
  writeFileSync(path.join(providers, 'local-node-runtime.js'), [
    'const RUNTIMES = {',
    ...ORIGINAL_RUNTIME_PORTS.map((port, index) => `  runtime${index}: { port: ${port}, marker: ${index} },`),
    '}',
    '',
  ].join('\n'))
  return payload
}

test('payload lookup distinguishes absence from a machine that could not look', () => {
  const absent = payloadManifestStatus('/not-used', () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  assert.deepEqual(absent, { status: 'absent' }, 'ENOENT remains the definite absent control')

  for (const thrown of [
    Object.assign(new Error('busy descriptors'), { code: 'EMFILE' }),
    Object.assign(new Error('try later'), { code: 'EAGAIN' }),
    Object.assign(new Error('input/output error'), { code: 'EIO' }),
    Object.assign(new Error('resource busy'), { code: 'EBUSY' }),
    'opaque failure',
  ]) {
    const result = payloadManifestStatus('/not-used', () => { throw thrown })
    assert.equal(result.status, 'indeterminate')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PACKAGED_QA_PAYLOAD_LOOKUP_INDETERMINATE')
    assert.match(result.reason, /not claiming that the packaged payload is absent/)
  }
})

test('optional audit and organisation reads suppress only genuine absence', () => {
  const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
  assert.equal(optionalFileContents('/not-used', () => { throw enoent }), null)

  const busy = Object.assign(new Error('busy'), { code: 'EMFILE' })
  assert.throws(
    () => optionalFileContents('/not-used', () => { throw busy }),
    error => error === busy,
    'a busy machine must not become an empty audit list or an absent organisation',
  )
})

test('launch-record expectations follow completed attempt stages, including a free local start', () => {
  const kindByTier = new Map([
    ['luna', 'codex'],
    ['claude-fable', 'claude'],
    ['local', 'local'],
  ])
  const answers = [
    { tier: 'luna', objectiveRef: 'fleet-page-lane', started: false, code: 'BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE' },
    { tier: 'claude-fable', objectiveRef: 'fleet-page-lane', started: false, code: 'BRIDGE_CLAUDE_CLI_NOT_INSTALLED' },
    ...['fleet-page-lane', 'Q1'].map(objectiveRef => ({
      tier: 'local', objectiveRef, started: true, providerFreeCompletion: true, code: null,
    })),
  ]

  assert.equal(dispatchAttemptStage(answers[0], 'codex'), 'after-launch-record')
  assert.equal(dispatchAttemptStage(answers[1], 'claude'), 'before-launch-record')
  assert.equal(dispatchAttemptStage(answers[2], 'local'), 'after-launch-record')
  assert.deepEqual(expectedLaunchAttempts(answers, kindByTier), [answers[0], answers[2], answers[3]],
    'only attempts that actually crossed createLaunch contribute to the audit count')
  assert.equal(dispatchOutcomeAllowed(answers[2], 'local'), true,
    'the credential-free local worker is allowed to start')
  assert.equal(dispatchOutcomeAllowed({ ...answers[2], tier: 'luna' }, 'codex'), false,
    'a paid provider starting in the providerless rig is still a failure')

  const observedRunShape = [
    ...['luna', 'terra', 'sol'].flatMap(tier => ['fleet-page-lane', 'Q1'].map(objectiveRef => ({
      tier, objectiveRef, started: false, code: 'BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE',
    }))),
    ...['claude-fable', 'claude-sonnet', 'claude-opus'].flatMap(tier => ['fleet-page-lane', 'Q1'].map(objectiveRef => ({
      tier, objectiveRef, started: false, code: 'BRIDGE_CLAUDE_CLI_NOT_INSTALLED',
    }))),
    ...['fleet-page-lane', 'Q1'].map(objectiveRef => ({
      tier: 'local', objectiveRef, started: true, providerFreeCompletion: true, code: null,
    })),
  ]
  const observedKinds = new Map([
    ['luna', 'codex'], ['terra', 'codex'], ['sol', 'codex'],
    ['claude-fable', 'claude'], ['claude-sonnet', 'claude'], ['claude-opus', 'claude'],
    ['local', 'local'],
  ])
  assert.equal(expectedLaunchAttempts(observedRunShape, observedKinds).length, 8,
    'six post-record Codex refusals plus both local objective starts produce eight records; Claude preflight produces none')
})

test('dispatch coverage requires exact tier/objective set equality independent of tier order', () => {
  const planned = [
    { tier: 'local', objectiveRef: 'fleet-page-lane' },
    { tier: 'local', objectiveRef: 'Q1' },
    { tier: 'luna', objectiveRef: 'fleet-page-lane' },
    { tier: 'luna', objectiveRef: 'Q1' },
  ]
  const answeredInDifferentOrder = [planned[2], planned[3], planned[0], planned[1]]
  assert.equal(dispatchCoverage(planned, answeredInDifferentOrder).ok, true)
  assert.equal(dispatchCoverage(planned, answeredInDifferentOrder.slice(0, -1)).ok, false,
    'an unanswered local objective pair must fail the gate')
  assert.equal(dispatchCoverage(planned, [...answeredInDifferentOrder.slice(0, -1), planned[0]]).ok, false,
    'a duplicate answer must not substitute for the missing pair')
  assert.equal(shouldAbortRemainingDispatches({ started: true }, 'local'), false,
    'a local success must leave the bridge alive for the other objective shape')
  assert.equal(shouldAbortRemainingDispatches({ started: true }, 'codex'), true,
    'a paid start still trips the immediate safety stop')
})

test('provider-free completion correlation requires a new POST after each dispatch', async () => {
  const runtime = { requests: [
    { method: 'GET', url: '/v1/models', completed: true },
    { method: 'POST', url: '/v1/chat/completions', completed: true },
  ] }
  assert.equal(providerFreeCompletionCount(runtime), 1)
  assert.equal(await waitForProviderFreeCompletion(runtime, { afterCount: 1, timeoutMs: 0 }), false,
    'the first local completion must not answer the second local dispatch')
  runtime.requests.push({ method: 'POST', url: '/v1/chat/completions', completed: true })
  assert.equal(await waitForProviderFreeCompletion(runtime, { afterCount: 1, timeoutMs: 0 }), true)
})

test('preflight refusals do not invent launch records and configuration failures stay red', () => {
  assert.equal(dispatchAttemptStage(
    { started: false, code: 'BRIDGE_LOCAL_RUNTIME_UNAVAILABLE' },
    'local',
  ), 'before-launch-record')
  assert.equal(dispatchAttemptStage(
    { started: false, code: 'BRIDGE_LOCAL_RUNNER_MISSING' },
    'local',
  ), 'before-launch-record')
  assert.equal(dispatchAttemptStage(
    { started: false, code: 'BRIDGE_MCP_CONFIG_UNAVAILABLE' },
    'claude',
  ), 'before-launch-record')
  assert.equal(dispatchOutcomeAllowed(
    { started: false, code: 'BRIDGE_MCP_CONFIG_UNAVAILABLE' },
    'claude',
  ), false, 'a broken packaged MCP configuration is not excused as provider absence')
})

test('the dispatch release gate cannot green on refusals alone', () => {
  const kinds = new Map([['luna', 'codex'], ['local', 'local']])
  const planned = [
    { tier: 'local', objectiveRef: 'fleet-page-lane' },
    { tier: 'local', objectiveRef: 'Q1' },
  ]
  const refusals = [
    { tier: 'local', objectiveRef: 'fleet-page-lane', started: false, code: 'BRIDGE_LOCAL_RUNTIME_UNAVAILABLE' },
    { tier: 'local', objectiveRef: 'Q1', started: false, code: 'BRIDGE_LOCAL_RUNTIME_UNAVAILABLE' },
  ]
  assert.equal(providerFreeObjectivesCompleted(planned, refusals, kinds), false)

  const completed = planned.map(({ tier, objectiveRef }) => ({
    tier, objectiveRef, started: true, providerFreeCompletion: true, code: null,
  }))
  assert.equal(providerFreeObjectivesCompleted(planned, completed, kinds), true)
  assert.equal(providerFreeObjectivesCompleted(planned, [...completed].reverse(), kinds), true,
    'completion proof must be independent of answer order')

  for (const refusedObjective of ['fleet-page-lane', 'Q1']) {
    const asymmetric = completed.map(answer => answer.objectiveRef === refusedObjective
      ? { ...answer, started: false, providerFreeCompletion: false, code: 'BRIDGE_LOCAL_RUNTIME_UNAVAILABLE' }
      : answer)
    assert.equal(providerFreeObjectivesCompleted(planned, asymmetric, kinds), false,
      `${refusedObjective} refusal cannot borrow the other objective's completed POST`)
  }

  assert.equal(providerFreeObjectivesCompleted(planned, completed.map((answer, index) => index === 0
    ? { ...answer, providerFreeCompletion: false }
    : answer), kinds), false, 'a started local worker without its own completed POST cannot green the gate')
})

test('the dispatch environment uses the shared credential and capability-path scrub before stricter overrides', () => {
  const previous = {
    vault: process.env.TOOLSENABLED_VAULT_PATH,
    token: process.env.OPENAI_API_KEY,
  }
  try {
    process.env.TOOLSENABLED_VAULT_PATH = 'C:\\ambient\\vault.json'
    process.env.OPENAI_API_KEY = 'must-not-cross'
    const root = mkdtempSync(path.join(tmpdir(), 'dispatch-providerless-env-'))
    try {
      const environment = providerlessEnvironment(root)
      assert.equal('TOOLSENABLED_VAULT_PATH' in environment, false)
      assert.equal('OPENAI_API_KEY' in environment, false)
      assert.equal(environment.APPDATA, path.join(root, 'no-npm'))
      assert.equal(environment.USERPROFILE, path.join(root, 'no-home'))
      assert.equal(environment.CODEX_HOME, path.join(root, 'no-home', '.codex'))
      assert.equal(environment.CLAUDE_CONFIG_DIR, path.join(root, 'no-home', '.claude'))
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      // This driver constructs a Windows launch environment even when these
      // portable assertions run on another OS. A drive colon is not its PATH
      // separator, and a sibling with the same prefix is not inside Windows.
      for (const entry of String(environment.PATH).split(path.win32.delimiter)) {
        assert.equal(path.win32.isAbsolute(entry), true, 'every search directory must be absolute')
        const relative = path.win32.relative(systemRoot, entry)
        assert.equal(relative === '' || (!path.win32.isAbsolute(relative)
          && relative !== '..' && !relative.startsWith('..\\')), true,
        'providerless search directories must stay inside the Windows system root')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    if (previous.vault === undefined) delete process.env.TOOLSENABLED_VAULT_PATH
    else process.env.TOOLSENABLED_VAULT_PATH = previous.vault
    if (previous.token === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous.token
  }
})

test('providerlessEnvironment is a structural allowlist: no npm_config_*, NODE_*, roaming-npm, or provider-home name -- nor an unknown injected canary -- ever reaches the dispatch child', () => {
  /* Every one of these is planted with an obviously fake value and none is
     read from anywhere real. npm_config_prefix/npm_config_cache/
     npm_config_globalconfig/npm_config_userconfig are the shape npm itself
     injects into every script it spawns (measured live: `npm run qa:packaged`
     sets npm_config_prefix to this account's real roaming npm root).
     NODE_PATH/NODE_OPTIONS are Node's own module/loader hooks. CODEX_HOME
     planted at a roaming path proves the redirect overrides a hostile
     ambient value rather than merely adding to it. C3_CANARY is not shaped
     like any of the above at all -- it exists to prove the fence excludes an
     unknown name, not just the ones this test happens to list. */
  const planted = Object.freeze({
    npm_config_prefix: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming\\npm',
    npm_config_cache: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming\\npm-cache',
    npm_config_globalconfig: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming\\npm\\etc\\npmrc',
    npm_config_userconfig: 'C:\\Users\\ToolsEnabled-Dev\\.npmrc',
    NODE_PATH: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming\\npm\\node_modules',
    NODE_OPTIONS: '--require C:\\hostile\\preload.js',
    C3_CANARY: 'this-name-is-on-no-denylist-at-all',
  })
  const before = new Map(Object.keys(planted).map(name => [name, process.env[name]]))
  const hostileCodexHome = process.env.CODEX_HOME
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-providerless-allowlist-'))
  try {
    for (const [name, value] of Object.entries(planted)) process.env[name] = value
    process.env.CODEX_HOME = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming\\.codex'
    const environment = providerlessEnvironment(root)

    const presentInObject = Object.keys(planted).filter(name => name in environment)
    assert.deepEqual(presentInObject, [],
      `providerlessEnvironment's own returned object still carries: ${presentInObject.join(', ')}`)
    assert.equal(environment.CODEX_HOME, path.join(root, 'no-home', '.codex'),
      'a hostile ambient CODEX_HOME must be overridden, not merely left uncounted')

    /* THE REAL WITNESS. The object could be clean while a call site still
       merges it over process.env; only a spawned child proves what actually
       arrives (the same reasoning tools/test/harness-credential-fence.test.mjs
       already applies to environmentFor()). */
    const probeNames = [...Object.keys(planted), 'CODEX_HOME']
    const script = 'const want = JSON.parse(process.argv[1]);'
      + 'console.log(JSON.stringify(Object.fromEntries(want.map(n => [n, process.env[n] ?? null]))))'
    const probe = spawnSync(process.execPath, ['-e', script, JSON.stringify(probeNames)], {
      env: environment, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    assert.equal(probe.error, undefined, `the probe child did not run: ${probe.error && probe.error.message}`)
    assert.equal(probe.status, 0, `the probe child exited ${probe.status}: ${String(probe.stderr).slice(0, 300)}`)
    const seenByChild = JSON.parse(String(probe.stdout).trim())
    const stillCarried = Object.keys(planted).filter(name => seenByChild[name] !== null)
    assert.deepEqual(stillCarried, [],
      `a real dispatch child would still see: ${stillCarried.join(', ')}`)
    assert.equal(seenByChild.CODEX_HOME, path.join(root, 'no-home', '.codex'),
      'the real dispatch child must see the sandboxed CODEX_HOME, not the ambient one')
  } finally {
    rmSync(root, { recursive: true, force: true })
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (hostileCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = hostileCodexHome
  }
})

test('providerlessEnvironment returns exactly its named allowlist keys, so the set can never grow silently', () => {
  /* The allowlist test above proves specific planted names stay out; this
     proves the CLOSED set -- that nothing at all beyond these twelve names
     is ever on the returned object, present or absent. A future edit that
     adds one more key back in (a reintroduced spread, a forgotten delete)
     changes this list of key NAMES even when every value still looks
     sandboxed, so this is the one assertion a value-shaped review could
     miss. Each name here is cited in this function's own header comment
     against the boot-path read that needs it. */
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-providerless-keyset-'))
  try {
    const environment = providerlessEnvironment(root)
    assert.deepEqual(Object.keys(environment).sort(), [
      'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'LOCALAPPDATA', 'PATH',
      'SystemRoot', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir',
    ].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the probe would have caught it -- an unscrubbed child sees every planted name', () => {
  /* THE POSITIVE CONTROL. Without this, the test above would also pass on a
     broken probe, a child that never started, or a spawn that silently
     dropped the environment -- and it would pass exactly as convincingly. */
  const planted = Object.freeze({
    npm_config_prefix: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming\\npm',
    C3_CANARY: 'this-name-is-on-no-denylist-at-all',
  })
  const before = new Map(Object.keys(planted).map(name => [name, process.env[name]]))
  try {
    for (const [name, value] of Object.entries(planted)) process.env[name] = value
    const script = 'const want = JSON.parse(process.argv[1]);'
      + 'console.log(JSON.stringify(want.filter(n => Object.prototype.hasOwnProperty.call(process.env, n))))'
    const probe = spawnSync(process.execPath, ['-e', script, JSON.stringify(Object.keys(planted))], {
      env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    assert.equal(probe.status, 0)
    const seenByChild = JSON.parse(String(probe.stdout).trim())
    assert.deepEqual(seenByChild.sort(), Object.keys(planted).sort(),
      'the probe cannot see an inherited name, so the allowlist test above proves nothing')
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('the packaged dispatch gate wires the deterministic local positive control before measurement', () => {
  const source = readFileSync(new URL('../agent-dispatch-packaged-qa.mjs', import.meta.url), 'utf8')
  const rig = source.indexOf('startProviderFreeLocalRuntime(payload)')
  const measurement = source.indexOf("measurePayload(payload, sandbox, 'shipped', dispatches, { localRuntime })")
  assert.ok(rig >= 0 && measurement > rig,
    'the provider-free local rig must be live before the packaged payload is dispatched')
  assert.match(source, /providerFreeObjectivesCompleted\(dispatches, measured\.answers, kinds\)/,
    'every planned local objective must carry its own successful completion proof')
  assert.match(source, /waitForProviderFreeCompletion\(localRuntime, \{ afterCount: completionsBefore \}\)/,
    'each local attempt must wait for its own newly completed provider-free POST')
  assert.match(source, /if \(shouldAbortRemainingDispatches\(answer, kind\)\)/,
    'only a paid-provider start may stop the remaining dispatch plan')
})

test('an explicit release is copied before the provider-free port rewrite and remains repeatable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-release-copy-'))
  try {
    const release = path.join(root, 'release')
    const sourcePayload = releasePayloadFixture(release)
    const sourceRuntime = path.join(sourcePayload, 'src', 'lib', 'providers', 'local-node-runtime.js')
    const before = readFileSync(sourceRuntime)

    for (const [index, port] of [45678, 45679].entries()) {
      const sandbox = path.join(root, `sandbox-${index}`)
      mkdirSync(sandbox)
      const resolved = copyReleasePayloadForMeasurement(release, sandbox)
      assert.equal(resolved.ok, true)
      assert.equal(path.resolve(resolved.sourcePayload), path.resolve(sourcePayload))
      assert.equal(path.resolve(resolved.payload).startsWith(`${path.resolve(sandbox)}${path.sep}`), true,
        'the mutable payload must live under the disposable QA sandbox')
      assert.notEqual(path.resolve(resolved.payload), path.resolve(sourcePayload))

      redirectLocalRuntimePorts(resolved.payload, port)
      assert.deepEqual(readFileSync(sourceRuntime), before,
        'the exact packaged payload changed while installing the loopback QA runtime')
      const copiedRuntime = readFileSync(path.join(resolved.payload, 'src', 'lib', 'providers', 'local-node-runtime.js'), 'utf8')
      assert.equal((copiedRuntime.match(new RegExp(`\\bport: ${port},`, 'g')) || []).length, ORIGINAL_RUNTIME_PORTS.length)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
