import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

// The original filename is retained; the paired account-selection contract is
// executed on both Linux and Windows. Provider/planner stand-ins isolate the
// real host's ordering and refusals; this is not native authentication proof.
const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { createAgentHost } = require(path.join(ROOT, 'shell/agent-host.cjs'))
const ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const planner = require(path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-session-confinement.js'))
const calls = require(ENGINE).calls
const scratch = testScratchRoot('.toolsenabled-linux-account-launch')
mkdirSync(scratch, { recursive: true })
test.after(() => rmSync(scratch, { recursive: true, force: true }))
const ISSUED = Buffer.alloc(32, 0x41).toString('base64url')

async function fixture(t, { resolution = { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }, throws = false, prepared = true, version = 1, selectedMode, preflightCode = null } = {}, run) {
  const root = mkdtempSync(path.join(scratch, 'case-'))
  const events = []
  const asked = []
  const bindings = []
  const selections = []
  let savedMode = selectedMode
  const labels = { Only: 'ToolsEnabled only', Enabled: 'ToolsEnabled and native tools', Disabled: 'Native tools only' }
  const oldVersion = planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION
  const oldPreflight = planner.preflightSessionPlan
  const oldPlan = planner.confinedSessionPlan
  const plan = options => ({ ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, servers: [],
    ...(selectedMode === undefined ? {} : { agentApiMode: options.agentApiMode ?? savedMode }),
    env: { CODEX_HOME: path.join(root, options.account ? 'named' : 'default'),
      ...(selectedMode === undefined ? {} : { TOOLSENABLED_AGENT_TOOL_MODE: labels[options.agentApiMode ?? savedMode] }) } })
  planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION = version
  planner.preflightSessionPlan = options => {
    events.push('preflight')
    if (preflightCode) return { ok: false, code: preflightCode }
    return { ...plan(options), prepared: false, preflightVersion: 1 }
  }
  planner.confinedSessionPlan = options => {
    events.push(options.sessionCredential ? 'credentialed' : 'prepared')
    asked.push(options)
    return { ...plan(options), ...(prepared ? {} : { prepared: false, preflightVersion: 1 }) }
  }
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: root, freeMemory: () => 64 * 1024 ** 3,
    async accountResolver(request, options) {
      events.push('selection')
      selections.push({ request, signal: options.signal })
      if (selectedMode !== undefined) savedMode = selectedMode === 'Disabled' ? 'Enabled' : 'Disabled'
      if (throws) throw new Error('untrusted resolver detail')
      return typeof resolution === 'function' ? resolution(root, request, options) : resolution
    },
    sessionAuthority: {
      toolModeVersion: 1,
      async bind(_principal, options) {
        events.push('bind'); bindings.push(options)
        if (selectedMode !== undefined) savedMode = selectedMode === 'Only' ? 'Enabled' : 'Only'
        return { bound: true, mode: 'owner-host', credential: ISSUED }
      },
      async revoke() { events.push('revoke'); return { revoked: true } },
    },
  })
  const before = calls.length
  try { await run({ host, root, events, asked, bindings, selections, before }) } finally {
    await host.closeAll()
    planner.confinedSessionPlan = oldPlan
    if (oldVersion === undefined) delete planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION
    else planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION = oldVersion
    if (oldPreflight === undefined) delete planner.preflightSessionPlan
    else planner.preflightSessionPlan = oldPreflight
    rmSync(root, { recursive: true, force: true })
  }
}

for (const selectedMode of ['Only', 'Enabled', 'Disabled']) {
  test(`host retains ${selectedMode} through Settings changes at account selection and credential binding`, async t => {
    await fixture(t, { selectedMode,
      resolution: root => ({ rotated: true, account: { name: 'work', provider: 'codex', resolvedHome: path.join(root, 'source') } }) },
    async ({ host, events, asked, bindings, before }) => {
      await host.startSession({ sessionId: 'captured-mode' })
      assert.deepEqual(events, ['preflight', 'selection', 'prepared', 'bind', 'credentialed'])
      assert.equal(calls.length, before + 1)
      assert.deepEqual(asked.map(item => item.agentApiMode), [selectedMode, selectedMode])
      assert.equal(bindings[0].agentApiMode, selectedMode)
      assert.equal(calls.at(-1).env.TOOLSENABLED_AGENT_TOOL_MODE,
        { Only: 'ToolsEnabled only', Enabled: 'ToolsEnabled and native tools', Disabled: 'Native tools only' }[selectedMode])
    })
  })
}

test('paired host prepares only the selected named account before binding authority', async t => {
  await fixture(t, { resolution: root => ({ rotated: true, account: { name: 'work', provider: 'codex', resolvedHome: path.join(root, 'source') } }) }, async ({ host, events, asked, before }) => {
    await host.startSession({ sessionId: 'paired-named' })
    assert.deepEqual(events, ['preflight', 'selection', 'prepared', 'bind', 'credentialed'])
    assert.equal(asked.length, 2)
    assert.ok(asked.every(options => options.account.name === 'work'))
    assert.equal(asked[0].sessionCredential, undefined)
    assert.equal(asked[1].sessionCredential, ISSUED)
    assert.equal(calls.length, before + 1)
  })
})

for (const resolution of [
  { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' },
  { rotated: false, account: null, code: 'ACCOUNTS_NONE_FOR_PROVIDER' }]) {
  test(`paired host explicitly prepares default after ${resolution?.code || 'explicit default'}`, async t => {
    await fixture(t, { resolution }, async ({ host, events, asked, before }) => {
      await host.startSession({ sessionId: 'paired-default' })
      assert.deepEqual(events, ['preflight', 'selection', 'prepared', 'bind', 'credentialed'])
      assert.ok(asked.every(options => !Object.hasOwn(options, 'account')))
      assert.equal(calls.length, before + 1)
    })
  })
}

for (const version of [1, 2]) test(`host refuses uncertain selection before authority or launch with preflight version ${version}`, async t => {
  for (const options of [
    { resolution: null },
    { throws: true },
    { resolution: () => undefined },
    { resolution: {} },
    { resolution: { rotated: false, account: null, code: 'ACCOUNTS_REGISTRY_UNREADABLE' } },
    { resolution: { rotated: true, account: { name: 'wrong', provider: 'claude', resolvedHome: '/unused' } } },
  ]) await fixture(t, { ...options, version }, async ({ host, events, before }) => {
    await assert.rejects(host.startSession({ sessionId: 'paired-uncertain' }), { code: 'AGENT_ACCOUNT_UNAVAILABLE' })
    assert.deepEqual(events, [version === 1 ? 'preflight' : 'prepared', 'selection'])
    assert.equal(calls.length, before)
  })
})

test('preflight is never accepted as a complete provider launch plan', async t => {
  await fixture(t, { prepared: false }, async ({ host, events, before }) => {
    await assert.rejects(host.startSession({ sessionId: 'paired-unprepared' }), { code: 'AGENT_CONFINEMENT_UNAVAILABLE' })
    assert.deepEqual(events, ['preflight', 'selection', 'prepared'])
    assert.equal(calls.length, before)
  })
})

test('unrecognized preflight version preserves legacy synchronous preparation', async t => {
  await fixture(t, { version: 2 }, async ({ host, events }) => {
    await host.startSession({ sessionId: 'legacy-version' })
    assert.deepEqual(events, ['prepared', 'selection', 'bind', 'credentialed'])
  })
})

test('paired confinement refusal remains synchronous before account selection or any home preparation', async t => {
  await fixture(t, { preflightCode: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' }, async ({ host, events, asked, before }) => {
    assert.throws(() => host.startSession({ sessionId: 'paired-policy-refused' }), { code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' })
    assert.deepEqual(events, ['preflight'])
    assert.deepEqual(asked, [])
    assert.equal(calls.length, before)
  })
})

test('an explicitly blocked account never prepares a default home or binds a provider identity', async t => {
  await fixture(t, { resolution: { rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL', reason: 'Synthetic account cutoff.' } }, async ({ host, events, asked, before }) => {
    await assert.rejects(host.startSession({ sessionId: 'paired-account-blocked' }), { code: 'ACCOUNT_EXHAUSTED_MANUAL' })
    assert.deepEqual(events, ['preflight', 'selection'])
    assert.deepEqual(asked, [])
    assert.equal(calls.length, before)
  })
})

test('Stop while account selection is pending cannot materialize any default or selected home', async t => {
  let release, entered
  const pending = new Promise(resolve => { entered = resolve })
  await fixture(t, { resolution: () => {
    entered()
    return new Promise(resolve => { release = resolve })
  } }, async ({ host, root, events, asked, before }) => {
    const starting = host.startSession({ sessionId: 'paired-stopped' }).then(value => ({ value }), error => ({ error }))
    await pending
    let closing
    try {
      closing = host.closeSession({ sessionId: 'paired-stopped' })
      release({ rotated: true, account: { name: 'work', provider: 'codex', resolvedHome: path.join(root, 'source') } })
      const outcome = await starting
      assert.equal(outcome.error?.code, 'AGENT_SESSION_START_CANCELLED')
      assert.deepEqual(await closing, { sessionId: 'paired-stopped', closed: true })
      assert.deepEqual(events, ['preflight', 'selection'])
      assert.deepEqual(asked, [])
      assert.equal(calls.length, before)
    } finally { release(null); await starting; await closing }
  })
})

test('paired exact resume selects its named account before preparation and cannot use a default or different account', async t => {
  for (const options of [
    { resolution: null },
    { throws: true },
    { resolution: {} },
    { resolution: { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' } },
    { resolution: root => ({ rotated: true, account: { name: 'different', provider: 'codex', resolvedHome: path.join(root, 'source') } }) },
  ]) await fixture(t, options, async ({ host, events, asked, selections, before }) => {
    await assert.rejects(host.startSession({ sessionId: 'paired-exact-refused', resumeThreadId: 'saved-thread', resumeAccount: 'work' }),
      { code: 'AGENT_RESUME_ACCOUNT_UNAVAILABLE' })
    assert.deepEqual(selections[0].request, { provider: 'codex', preferred: 'work', exact: true })
    assert.deepEqual(events, ['preflight', 'selection'])
    assert.deepEqual(asked, [])
    assert.equal(calls.length, before)
  })
  await fixture(t, { resolution: root => ({ rotated: true, account: { name: 'work', provider: 'codex', resolvedHome: path.join(root, 'source') } }) },
    async ({ host, asked, selections, before }) => {
      await host.startSession({ sessionId: 'paired-exact-accepted', resumeThreadId: 'saved-thread', resumeAccount: 'work' })
      assert.deepEqual(selections[0].request, { provider: 'codex', preferred: 'work', exact: true })
      assert.equal(calls.length, before + 1)
      assert.equal(calls.at(-1).resumed, true)
      assert.equal(calls.at(-1).threadId, 'saved-thread')
      assert.ok(asked.every(options => options.account.name === 'work'))
    })
})

test('paired exact resume retains the original named account refusal without preparing or binding another identity', async t => {
  for (const [status, code] of [
    ['exhausted', 'AGENT_RESUME_ACCOUNT_LIMIT'],
    ['signed_out', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'],
    ['not_provisioned', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'],
    ['transient', 'AGENT_RESUME_ACCOUNT_UNAVAILABLE'],
  ]) await fixture(t, { resolution: { rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL',
    attempts: [{ account: 'different', status: 'exhausted' }, { account: 'work', status }] } },
  async ({ host, events, asked, before }) => {
    await assert.rejects(host.startSession({ sessionId: `paired-exact-${status}`, resumeThreadId: 'saved-thread', resumeAccount: 'work' }), { code })
    assert.deepEqual(events, ['preflight', 'selection'])
    assert.deepEqual(asked, [])
    assert.equal(calls.length, before)
  })
})

for (const resumed of [false, true]) test(`paired ${resumed ? 'exact resume' : 'fresh start'} cancellation wins over a late resolver rejection`, async t => {
  let reject, entered
  const pending = new Promise(resolve => { entered = resolve })
  await fixture(t, { resolution: () => { entered(); return new Promise((_resolve, no) => { reject = no }) } },
    async ({ host, events, asked, selections, before }) => {
      const starting = host.startSession({ sessionId: 'paired-cancel-rejection',
        ...(resumed ? { resumeThreadId: 'saved-thread', resumeAccount: 'work' } : {}) }).then(value => ({ value }), error => ({ error }))
      await pending
      const closing = host.closeAll()
      const aborted = selections[0].signal.aborted
      reject(new Error('Synthetic resolver failure after cancellation'))
      assert.equal(aborted, true, 'Shutdown must reach the still-pending account selector')
      assert.equal((await starting).error?.code, 'AGENT_SESSION_START_CANCELLED')
      await closing
      assert.deepEqual(events, ['preflight', 'selection'])
      assert.deepEqual(asked, [])
      assert.equal(calls.length, before)
      assert.equal(host.sessionActivity('paired-cancel-rejection'), null)
    })
})
