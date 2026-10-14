import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { unavailableReason } from '../../src/agent-availability-copy.js'

const require = createRequire(import.meta.url)
const ENGINE = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const codex = require(ENGINE)
const claude = require('./fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js')
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

function dom(t) {
  const { document, restore } = installDomStandIn()
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) }
  const cleanup = () => { if (old) Object.defineProperty(globalThis, 'localStorage', old); else delete globalThis.localStorage; restore() }
  const root = document.createElement('div')
  document.body.appendChild(root)
  root.cleanup = cleanup
  return root
}

for (const [provider, tier] of [['claude', 'claude-sonnet'], ['codex', 'astra']]) {
  test(`${provider}: standalone Stop then Send resumes the provider conversation before sending the recall`, async t => {
    const root = dom(t), starts = [], sends = [], closes = []
    let control, receive
    const threadId = provider + '-saved-thread'
    const bridge = {
      availability: async () => ({ ok: true }),
      onEvent: fn => { receive = fn; return () => {} },
      start: async request => {
        starts.push(request)
        if (starts.length === 2) {
          assert.equal(request.resumeThreadId, threadId)
          assert.equal(request.resumeSessionId, starts[0].sessionId)
          assert.equal(request.resumeThreadProvider, provider)
          assert.equal(request.resumeAccount, 'original-account')
        }
        return { sessionId: request.sessionId, threadId, provider, account: 'original-account' }
      },
      send: async request => { sends.push(request); return { turnId: 'turn-' + sends.length } },
      interrupt: async () => ({ ok: true }),
      close: async request => { closes.push(request); return { closed: true } },
    }
    const release = mountAgentSessionSurface(root, { live: true, bridge, chatComposer: true,
      onController: value => { control = value }, getStartOptions: () => ({ tier }) })
    t.after(() => { release(); root.cleanup() })
    assert.equal((await control.send('Remember CHECKWORD.')).ok, true)
    receive({ sessionId: starts[0].sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'success' } })
    assert.equal((await control.terminate()).ok, true)
    assert.equal(control.snapshot().sessionId, null)
    assert.equal((await control.send('Which word did I ask you to remember?')).ok, true)
    assert.equal(starts.length, 2)
    assert.equal(closes.length, 1)
    assert.equal(sends.length, 2)
    assert.notEqual(sends[1].sessionId, sends[0].sessionId, 'a stopped process needs a new live session')
    assert.equal(sends[1].sessionId, starts[1].sessionId)
    assert.equal(sends[1].text, 'Which word did I ask you to remember?')
    assert.equal(control.snapshot().threadId, threadId, 'the provider conversation must stay the same')
  })
}

async function hostFixture(t, provider, named, { nativeHome = 'explicit' } = {}) {
  const scratch = testScratchRoot('.toolsenabled-stop-resume')
  mkdirSync(scratch, { recursive: true })
  const cwd = mkdtempSync(path.join(scratch, 'run-'))
  const home = path.join(cwd, 'original-home'), changedHome = path.join(cwd, 'later-home')
  let defaultHome = home
  const calls = [], selections = []
  const adapter = { sendTurn: async request => { calls.push({ send: request }); return { turnId: 'turn-1' } },
    interrupt: async () => {}, answerApproval() {},
    forkThread: async () => ({ threadId: 'rewound-native-thread' }) }
  const start = async options => { calls.push({ start: options }); return { adapter, threadId: 'saved-native-thread', close() {} } }
  const resume = async options => { calls.push({ resume: options }); return { adapter, threadId: options.threadId, resumed: { turns: [], turnCount: 0 }, close() {} } }
  const engine = provider === 'claude' ? claude : codex
  t.mock.method(engine, provider === 'claude' ? 'startClaudeSession' : 'startCodexSession', start)
  t.mock.method(engine, provider === 'claude' ? 'resumeClaudeSession' : 'resumeCodexSession', resume)
  const planner = require('./fixtures/confined-engine/src/lib/agent-session-confinement.js')
  const previousArgs = Object.getOwnPropertyDescriptor(planner, 'codexConfigOverrideArgs')
  const renderCodexArgs = require(fileURLToPath(new URL('../../../engine/src/lib/agent-session-confinement.js', import.meta.url))).codexConfigOverrideArgs
  planner.codexConfigOverrideArgs = renderCodexArgs
  t.after(() => { if (previousArgs) Object.defineProperty(planner, 'codexConfigOverrideArgs', previousArgs); else delete planner.codexConfigOverrideArgs })
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: cwd,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(cwd).root,
    freeMemory: () => 64 * 1024 * 1024 * 1024,
    accountResolver: async request => {
      selections.push(request)
      return named ? { rotated: true, account: { name: request.preferred || 'original-account', provider, resolvedHome: defaultHome } }
        : selections.length === 1 ? { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }
          : { rotated: true, account: { name: 'later-account', provider, resolvedHome: changedHome } }
    },
    confinementPlanner: ({ account } = {}) => ({ ok: true, tier: 'unrestricted', isolated: false,
      threadOptions: {}, account: account?.name || null,
      ...(nativeHome !== 'explicit' ? { env: { HOME: defaultHome, USERPROFILE: defaultHome,
        ...(nativeHome === 'inherited' ? { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: defaultHome }
          : provider === 'claude' ? { CLAUDE_CONFIG_DIR: '' } : {}) } }
        : provider === 'claude' ? { configDir: account?.resolvedHome || defaultHome }
          : { env: { CODEX_HOME: account?.resolvedHome || defaultHome },
            codexConfig: { sqlite_home: account?.resolvedHome || defaultHome },
            codexArgs: renderCodexArgs({ sqlite_home: account?.resolvedHome || defaultHome }) }) }),
  })
  t.after(async () => { await host.closeAll(); rmSync(cwd, { recursive: true, force: true }) })
  return { host, calls, selections, home, changeHome: () => { defaultHome = changedHome } }
}

for (const [provider, tier] of [['claude', 'claude-sonnet'], ['codex', 'astra']]) {
  for (const named of [false, true]) {
    test(`${provider}: Stop then resume keeps the ${named ? 'named' : 'default'} account's home affinity`, async t => {
      const f = await hostFixture(t, provider, named)
      const first = await f.host.startSession({ sessionId: 'original-session', tier })
      await f.host.sendTurn({ sessionId: first.sessionId, text: 'Remember CHECKWORD.' })
      await f.host.closeSession({ sessionId: first.sessionId })
      // Default Claude follows the native launch home and refuses a changed
      // one; other resumes still retain the observed account's home.
      if (!named) f.changeHome()
      if (!named && provider === 'claude') {
        await assert.rejects(f.host.startSession({ sessionId: 'refused-session', tier,
          resumeThreadId: first.threadId, resumeThreadProvider: provider, resumeSessionId: first.sessionId }),
          { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
        assert.equal(f.calls.filter(call => call.resume).length, 0)
        assert.equal(f.selections.length, 1)
        return
      }
      const resumed = await f.host.startSession({ sessionId: 'resumed-session', tier,
        resumeThreadId: first.threadId, resumeThreadProvider: provider, resumeSessionId: first.sessionId,
        ...(named ? { resumeAccount: first.account } : {}) })
      assert.equal(resumed.threadId, first.threadId)
      assert.equal(resumed.account, named ? 'original-account' : null)
      const launch = f.calls.find(call => call.resume)?.resume
      assert.ok(launch, 'the provider resume entry point was called')
      assert.equal(launch.threadId, first.threadId)
      assert.equal(provider === 'claude' ? launch.configDir || launch.plan?.configDir : launch.env.CODEX_HOME, f.home)
      if (provider === 'codex') {
        assert.equal(launch.plan.codexConfig.sqlite_home, f.home, 'native history must use the original database home')
        assert.ok(launch.plan.codexArgs.includes('sqlite_home=' + JSON.stringify(f.home)), 'argv must carry the same original history home')
      }
      assert.equal(f.selections.length, named ? 2 : 1, 'default resumes must not select a newly chosen named account')
      if (named) {
        assert.equal(f.selections[1].preferred, 'original-account')
        assert.equal(f.selections[1].persistSelection, false)
      }
      await f.host.sendTurn({ sessionId: resumed.sessionId, text: 'Recall the word.' })
      assert.equal(f.calls.at(-1).send.threadId, first.threadId)
    })
  }
  test(`${provider}: Stop refuses a named account whose configured home changed, preserving its native conversation`, async t => {
    const f = await hostFixture(t, provider, true)
    const first = await f.host.startSession({ sessionId: 'original-session', tier })
    await f.host.closeSession({ sessionId: first.sessionId })
    f.changeHome()
    await assert.rejects(f.host.startSession({ sessionId: 'refused-successor', tier, resumeThreadId: first.threadId,
      resumeThreadProvider: provider, resumeSessionId: first.sessionId, resumeAccount: first.account }),
      { code: 'AGENT_RESUME_HOME_CHANGED' })
    assert.equal(f.calls.filter(call => call.resume).length, 0)
    assert.equal(f.calls.filter(call => call.start).length, 1)
    assert.match(unavailableReason('AGENT_RESUME_HOME_CHANGED'), /conversation is kept/i)
  })
  test(`${provider}: a restored source without original-home evidence refuses before provider launch`, async t => {
    const f = await hostFixture(t, provider, true)
    assert.throws(() => f.host.startSession({ sessionId: 'new-session', tier,
      resumeThreadId: 'saved-native-thread', resumeThreadProvider: provider, resumeSessionId: 'before-hard-kill' }),
      { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.selections, [])
    const words = unavailableReason('AGENT_RESUME_HOME_UNAVAILABLE')
    assert.match(words, /original sign-in home/)
    assert.match(words, /conversation is kept/i)
    assert.doesNotMatch(words, /could not work out why/)
  })
}

for (const [provider, tier] of [['claude', 'claude-sonnet'], ['codex', 'astra']]) {
  for (const nativeHome of ['inherited', 'profile-default']) {
    test(`${provider}: an older planner's ${nativeHome} pointer retains default resume affinity when the home changes`, async t => {
      const f = await hostFixture(t, provider, false, { nativeHome })
      const first = await f.host.startSession({ sessionId: 'original-session', tier })
      const initial = f.calls.find(call => call.start).start
      const variable = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
      assert.equal(initial.env.HOME, f.home)
      if (nativeHome === 'inherited') assert.equal(initial.env[variable], f.home)
      const actualHome = nativeHome === 'inherited' ? f.home : path.join(f.home, provider === 'claude' ? '.claude' : '.codex')
      await f.host.closeSession({ sessionId: first.sessionId })
      f.changeHome()
      const resume = () => f.host.startSession({ sessionId: 'resumed-session', tier,
        resumeThreadId: first.threadId, resumeThreadProvider: provider, resumeSessionId: first.sessionId })
      if (provider === 'claude') {
        await assert.rejects(resume(), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
        assert.equal(f.calls.filter(call => call.resume).length, 0, 'a changed default Claude home must refuse before dispatch')
        assert.equal(f.selections.length, 1)
        return
      }
      const resumed = await resume()
      const launch = f.calls.find(call => call.resume)?.resume
      assert.ok(launch, 'the native resume is admitted using its observed home')
      assert.equal(provider === 'claude' ? launch.configDir || launch.plan?.configDir : launch.env.CODEX_HOME, actualHome)
      assert.equal(resumed.threadId, first.threadId)
      assert.equal(resumed.account, null)
      assert.equal(f.selections.length, 1)
    })
  }
}

for (const [provider, tier] of [['claude', 'claude-sonnet'], ['codex', 'astra']]) {
  test(`${provider}: retained source identity cannot be resumed under a different thread or account`, async t => {
    const f = await hostFixture(t, provider, true)
    const first = await f.host.startSession({ sessionId: 'original-session', tier })
    await f.host.closeSession({ sessionId: first.sessionId })
    for (const wrong of [{ resumeThreadId: 'another-thread' }, { resumeAccount: 'another-account' }, { treeAccount: 'another-account' }]) {
      assert.throws(() => f.host.startSession({ sessionId: 'refused-session', tier,
        resumeThreadId: first.threadId, resumeSessionId: first.sessionId, ...wrong }),
        { code: 'AGENT_RESUME_IDENTITY_MISMATCH' })
    }
    assert.equal(f.calls.filter(call => call.resume).length, 0)
  })
  test(`${provider}: the retained provider cannot be changed by omitting renderer provider metadata`, async t => {
    const f = await hostFixture(t, provider, true)
    const first = await f.host.startSession({ sessionId: 'original-session', tier })
    await f.host.closeSession({ sessionId: first.sessionId })
    assert.throws(() => f.host.startSession({ sessionId: 'refused-session', tier: provider === 'claude' ? 'astra' : 'claude-sonnet',
      resumeThreadId: first.threadId, resumeSessionId: first.sessionId }),
      { code: 'AGENT_RESUME_PROVIDER_MISMATCH' })
    assert.equal(f.calls.filter(call => call.resume).length, 0)
  })
}


for (const [provider, tier] of [['claude', 'claude-sonnet'], ['codex', 'astra']]) {
  test(`${provider}: a tree-style resume without a renderer source selector enforces the host-observed home`, async t => {
    const f = await hostFixture(t, provider, false)
    const first = await f.host.startSession({ sessionId: 'original-session', tier })
    await f.host.closeSession({ sessionId: first.sessionId })
    f.changeHome()
    if (provider === 'claude') {
      await assert.rejects(f.host.startSession({ sessionId: 'refused-session', tier, resumeThreadId: first.threadId }),
        { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
      assert.equal(f.calls.filter(call => call.resume).length, 0)
      assert.equal(f.selections.length, 1)
      return
    }
    const resumed = await f.host.startSession({ sessionId: 'resumed-session', tier, resumeThreadId: first.threadId })
    assert.equal(resumed.threadId, first.threadId)
    const launch = f.calls.find(call => call.resume)?.resume
    assert.equal(provider === 'claude' ? launch.configDir || launch.plan?.configDir : launch.env.CODEX_HOME, f.home)
    assert.equal(f.selections.length, 1)
  })
}
test('a Codex rewind then Stop resumes the new native thread from the original home', async t => {
  const f = await hostFixture(t, 'codex', false)
  const first = await f.host.startSession({ sessionId: 'original-session', tier: 'astra' })
  const rewind = await f.host.rewindSession({ sessionId: first.sessionId, turnId: 'kept-turn' })
  assert.equal(rewind.threadId, 'rewound-native-thread')
  await f.host.closeSession({ sessionId: first.sessionId })
  f.changeHome()
  const resumed = await f.host.startSession({ sessionId: 'resumed-session', tier: 'astra',
    resumeThreadId: rewind.threadId, resumeSessionId: first.sessionId })
  assert.equal(resumed.threadId, 'rewound-native-thread')
  assert.equal(f.calls.find(call => call.resume)?.resume.env.CODEX_HOME, f.home)
})

test('a restored standalone tab carries canonical native identity and keeps its first refused send as a draft', async t => {
  const root = dom(t), starts = [], sends = []
  const bridge = { availability: async () => ({ ok: true }), onEvent: () => () => {},
    ownerContext: async () => ({ version: 1, ownerId: 'fixture-owner', currentEpoch: 'fixture-epoch', kind: 'local' }),
    onOwnerContextChanged: () => () => {},
    start: async request => { starts.push(request); throw Object.assign(new Error('AGENT_RESUME_HOME_UNAVAILABLE'), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' }) },
    send: async request => { sends.push(request); return { turnId: 'unexpected' } },
    interrupt: async () => ({ ok: true }),
    close: async () => { throw Object.assign(new Error('MC_AGENT_UNKNOWN_SESSION'), { code: 'MC_AGENT_UNKNOWN_SESSION' }) },
  }
  const panel = mountStandaloneAgent(root, { id: 'saved-seat', live: true, bridge,
    start: { tier: 'claude-sonnet', effort: 'low' }, restored: { nativeSessionId: 'native-source',
      sessionId: 'tab-source', threadId: 'saved-native-thread', provider: 'claude', account: 'original-account',
      lines: [{ who: 'you', text: 'Remember CHECKWORD.', at: 1 }], cause: 'restart' } })
  t.after(async () => { panel.dispose(); await settle(); root.cleanup() })
  await settle()
  const input = root.querySelector('.chat-input textarea')
  input.value = 'Recall the word.'
  input.dispatch('input')
  root.querySelector('.chat-send').click()
  await settle()
  assert.equal(starts.length, 1, root.textContent)
  assert.equal(starts[0].resumeSessionId, 'native-source')
  assert.equal(starts[0].resumeThreadId, 'saved-native-thread')
  assert.equal(starts[0].resumeThreadProvider, 'claude')
  assert.equal(starts[0].resumeAccount, 'original-account')
  assert.equal(Object.hasOwn(starts[0], 'historyHandoff'), false, 'native resume must not create a speech-seeded replacement')
  assert.deepEqual(sends, [])
  assert.equal(input.value, 'Recall the word.')
  assert.match(root.textContent, /original sign-in home/)
})

test('the integrated account resolver accepts ordinary selection without retired retry parameters', async () => {
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const begin = source.indexOf('async function resolveSessionAccount(')
  const end = source.indexOf('\n/* The same directory', begin)
  assert.ok(begin >= 0 && end > begin)
  const requests = []
  const resolve = vm.runInNewContext('(' + source.slice(begin, end).trim() + ')', {
    loadRotation: () => ({ ACCOUNT_REQUEST_SELECTION_VERSION: 1, ACCOUNT_MODEL_SCOPE_CONTRACT_VERSION: 1,
      resolveAccountForSession: async request => { requests.push(request); return { rotated: true, account: { name: 'original-account' } } } }),
    PROVIDER_ISOLATION_REQUESTED: false, ACCOUNT_HOME_DIR: 'fixture-home',
    resolveServicesRootForAccounts: () => 'fixture-state',
  })
  const selected = await resolve({ provider: 'codex', preferred: 'original-account', exact: true })
  assert.equal(selected.account.name, 'original-account')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].preferred, 'original-account')
})

test('a saved conversation without native identity refuses specifically before starting and preserves delivery certainty', async t => {
  const root = dom(t)
  let control, starts = 0
  const bridge = { availability: async () => ({ ok: true }), onEvent: () => () => {},
    start: async () => { starts++; return { sessionId: 'unexpected' } },
    send: async () => ({ turnId: 'unexpected' }), close: async () => ({ closed: true }), interrupt: async () => ({ ok: true }) }
  const release = mountAgentSessionSurface(root, { live: true, bridge, chatComposer: true,
    resumeConversation: { sessionId: 'saved-source', threadId: null, provider: 'claude' },
    onController: value => { control = value } })
  t.after(() => { release(); root.cleanup() })
  const result = await control.send('Recall the word.')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_RESUME_IDENTITY_UNAVAILABLE')
  assert.equal(result.deliveryDisposition, 'not-sent')
  assert.equal(starts, 0)
  assert.match(root.textContent, /verified native .*identity/)
})

test('the IPC accepts a bounded original-session selector only alongside its saved thread', () => {
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const ast = parseAst(source)
  const functions = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'boundedAgentModel', 'parseAgentStart']
  const declarations = functions.map(name => {
    const nodes = ast.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === name)
    assert.equal(nodes.length, 1)
    return source.slice(nodes[0].start, nodes[0].end)
  })
  for (const name of ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'AGENT_EFFORT_VALUES']) {
    const nodes = ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).filter(node => node.id.name === name)
    assert.equal(nodes.length, 1)
    declarations.push('const ' + source.slice(nodes[0].start, nodes[0].end) + ';')
  }
  const parse = new Function('require', 'resolveCapabilityRoot', 'randomUUID', 'MAX_ACCOUNT_NAME_LENGTH',
    declarations.join('\n') + '\nreturn parseAgentStart;'
  )(require, () => fileURLToPath(new URL('../../../engine/', import.meta.url)), () => 'fixture-session', 128)
  const result = parse({ sessionId: 'new-session', resumeThreadId: 'saved-thread', resumeSessionId: 'original-session' })
  assert.equal(result.resumeSessionId, 'original-session')
  assert.equal(result.resumeThreadId, 'saved-thread')
  assert.throws(() => parse({ resumeSessionId: 'original-session' }), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  for (const resumeSessionId of ['', 42, 'x'.repeat(129)]) {
    assert.throws(() => parse({ resumeThreadId: 'saved-thread', resumeSessionId }), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  }
})

test('a native thread-change event followed by Stop resumes the updated conversation identity', async t => {
  const root = dom(t)
  let control, receive, expectedThread = 'original-native-thread'
  const starts = []
  const bridge = {
    availability: async () => ({ ok: true }), onEvent: fn => { receive = fn; return () => {} },
    start: async request => {
      starts.push(request)
      return { sessionId: request.sessionId, threadId: expectedThread, provider: 'codex', account: null }
    },
    send: async () => ({ turnId: 'fixture-turn' }), interrupt: async () => ({}), close: async () => ({ closed: true }),
  }
  const release = mountAgentSessionSurface(root, { live: true, bridge, chatComposer: true,
    onController: value => { control = value } })
  t.after(() => { release(); root.cleanup() })
  await control.send('Remember CHECKWORD.')
  expectedThread = 'rewound-native-thread'
  receive({ sessionId: starts[0].sessionId, event: { type: 'session_thread_changed', threadId: expectedThread } })
  await control.terminate()
  assert.equal((await control.send('Recall the word.')).ok, true)
  assert.equal(starts[1].resumeThreadId, 'rewound-native-thread')
  assert.equal(control.snapshot().threadId, 'rewound-native-thread')
})

test('a paired engine that cannot bind the saved Codex database home refuses specifically before resuming', async t => {
  const f = await hostFixture(t, 'codex', false)
  const first = await f.host.startSession({ sessionId: 'original-session', tier: 'astra' })
  await f.host.closeSession({ sessionId: first.sessionId })
  const planner = require('./fixtures/confined-engine/src/lib/agent-session-confinement.js')
  const renderArgs = planner.codexConfigOverrideArgs
  delete planner.codexConfigOverrideArgs
  try {
    await assert.rejects(f.host.startSession({ sessionId: 'resumed-session', tier: 'astra',
      resumeThreadId: first.threadId, resumeSessionId: first.sessionId }), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
    assert.equal(f.calls.filter(call => call.resume).length, 0)
  } finally { planner.codexConfigOverrideArgs = renderArgs }
})
