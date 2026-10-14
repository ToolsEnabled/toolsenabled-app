import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import { reopenFixtureEngine } from './helpers/reopen-fixture-engine.mjs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseAst } from 'rollup/parseAst'
const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createLegacyResumeOriginResolver } = require('../../shell/legacy-resume-origin.cjs')
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { unavailableReason } from '../../src/agent-availability-copy.js'
import { engineReason } from '../../src/local-activity.js'
import { QUEUE_PANEL } from '../../src/fleet-tree-copy.js'
import { installWorld, fleetFetch, seedTreeNode, mountView, settle } from './lib/tree-command-real-mount.mjs'
import { parseNativeStart } from './helpers/native-start-parser.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

let serial = 0
async function mount(t, { early = false, nameless = false, held = false, nativeFixture = false, damage = null, neverStarts = false, paginated = false, named = false, provider = 'codex', registryAtCreation = false, removedAccount = false, cold50 = false, changedHome = false, pendingNativeResume = false, signedOutAfterStop = false } = {}) {
  const computerId = 'c5-fixture-computer-' + ++serial, nodeId = 'c5-default-tree-' + serial
  let sessionId = 'c5-successor-' + serial
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  const previousOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  const packets = new Set(), starts = [], sends = [], sendRequests = []
  let releaseSend
  const emit = async event => { await Promise.all([...packets].map(fn => fn({ sessionId, event }))) }
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/workspace'] }) }
  window.mcProviders = { presence: async () => ({ codex: { installed: true } }) }
  world.bridge.confinement = async () => ({ ok: true, tier: 'standard', isolated: true, recorded: true })
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  world.bridge.onEvent = fn => { packets.add(fn); return () => packets.delete(fn) }
  world.bridge.start = async request => {
    starts.push(request)
    if (!request.resumeThreadId) sessionId = request.sessionId || sessionId
    return request.resumeThreadId
      ? { ok: false, code: 'CODEX_THREAD_NOT_FOUND', startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
      : { ok: true, sessionId: request.sessionId || sessionId, threadId: 'fresh-provider-thread', account: null }
  }
  world.bridge.sendAutomatic = async request => {
    sends.push(request)
    if (early) {
      await emit({ type: 'assistant_text_delta', text: 'Complete. No unfinished work remains.', ...(nameless ? {} : { turnId: 'seed-turn' }) })
      await emit({ type: 'turn_completed', status: 'completed', ...(nameless ? {} : { turnId: 'seed-turn' }) })
    }
    if (held) await new Promise(resolve => { releaseSend = resolve })
    return { ok: true, deliveryDisposition: 'accepted', result: { sessionId, turnId: 'seed-turn' } }
  }
  world.bridge.send = async request => { sends.push(request); return { sessionId, turnId: 'recall-turn' } }
  const agents = [{ id: nodeId, role: 'builder', provider, enabled: true }]
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org: { revision: 1, agents, edges: [] },
    roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  seedTreeNode(world.storage, { computerId, nodeId, sessionId: 'published48-source', status: 'finished' })
  const tree = JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId)))
  tree.nodes[0].tier = provider === 'claude' ? 'claude-sonnet-5' : provider === 'gemini' ? 'gemini' : 'luna'
  world.storage.setItem(fleetTreesStorageKey(computerId), JSON.stringify(tree))
  const saved = { computerId, nodeId, threadId: 'published48-thread', provider, account: null,
    savedAt: 1, revision: 1 }
  window.mcTranscripts = { list: async () => ({ ok: true, records: [saved] }),
    read: async () => ({ ok: true, metadata: saved, entries: [
      { id: 'old-person', who: 'you', text: 'Remember CHECKWORD.', at: 1 },
      { id: 'old-agent', who: 'agent', text: 'CHECKWORD', at: 2 },
    ] }), append: async () => ({ ok: true }), bind: async () => ({ ok: true }),
    onError: () => () => {} }
  let native
  if (nativeFixture) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'c5-default-tree-'))
    const defaultHome = provider === 'gemini' ? directory : path.join(directory, '.' + provider), namedHome = path.join(directory, 'named-home')
    const sessions = path.join(directory, 'agent-home', '@agents', nodeId, '@sessions')
    const leaf = named ? 'registered-later' : '@default'
    saved.account = named ? 'registered-later' : null
    const oldHome = path.join(sessions, 'a'.repeat(64), provider, 'standard', leaf)
    const threadId = '12345678-1234-4123-8123-123456789abc'
    saved.threadId = threadId
    if (defaultHome !== directory) mkdirSync(defaultHome); mkdirSync(namedHome); mkdirSync(path.join(oldHome, 'sessions'), { recursive: true })
    const source = path.join(oldHome, 'sessions', 'rollout-' + threadId + '.jsonl')
    writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: threadId, ...(paginated ? { history_mode: 'paginated' } : {}) } }) + '\n')
    if (paginated) writeFileSync(path.join(oldHome, 'thread_history_1.sqlite'), '')
    if (named) writeFileSync(path.join(oldHome, 'toolsenabled-account.json'), JSON.stringify({ name: saved.account }))
    const signIn = path.join(oldHome, provider === 'codex' ? 'auth.json' : provider === 'claude' ? '.credentials.json' : '.gemini/oauth_creds.json')
    mkdirSync(path.dirname(signIn), { recursive: true })
    writeFileSync(signIn, '')
    const registryFile = path.join(directory, 'accounts.json')
    const field = provider === 'codex' ? 'profileDir' : provider === 'claude' ? 'configDir' : 'homeDir'
    // Default before registration, default with another provider registered,
    // and a named conversation already registered are the possible 1.0.48 rows.
    writeFileSync(registryFile, JSON.stringify({ accounts: named ? [{ provider, name: 'registered-later', [field]: namedHome }]
      : registryAtCreation ? [{ provider: 'claude', name: 'earlier-other-provider', configDir: namedHome }] : [] }))
    writeFileSync(registryFile, JSON.stringify({ accounts: removedAccount && !cold50 ? [] : [{ provider, name: 'registered-later', [field]: namedHome }] }))
    const registry = require('../../shell/account-registry.cjs').createAccountRegistryStore({ file: registryFile, homedir: () => directory })
    const cleanup = await require('../../../engine/src/lib/legacy-signin-cleanup.js').cleanupLegacySignIns({ servicesRoot: directory })
    assert.equal(cleanup.removedCount, 1)
    assert.equal(existsSync(signIn), false)
    assert.equal(existsSync(source), true)
    const launches = [], selections = [], refused = []
    let rejectUnstarted, finishLate
    const { enginePath, engine, start, resume } = reopenFixtureEngine(directory, provider)
    const previousContract = engine.RESUME_SOURCE_CONTRACT_VERSION
    engine.RESUME_SOURCE_CONTRACT_VERSION = 2
    const launch = async (kind, request) => {
      launches.push({ kind, request })
      // Capture the selected native launch even when a mutation points it at
      // the wrong home/history. Assertions below reject that launch; inventing
      // an after-dispatch child failure here obscures the affinity check.
      return { threadId: kind === 'resume' || cold50 ? threadId : 'fresh-provider-thread', resumed: { turns: [], turnCount: 0 },
        adapter: { sendTurn: async turn => { sends.push(turn)
          if (neverStarts) {
            request.onEvent({ type: 'assistant_text_delta', text: 'Complete. No unfinished work remains.' })
            return new Promise((resolve, reject) => { rejectUnstarted = reject
              finishLate = async () => {
                await request.onEvent({ type: 'turn_started', threadId, turnId: 'late-turn' })
                resolve({ turnId: 'late-turn' })
                await settle(8)
                await request.onEvent({ type: 'turn_completed', status: 'completed', threadId, turnId: 'late-turn' })
              }
            })
          }
          await request.onEvent({ type: 'assistant_text_delta', text: 'CHECKWORD', threadId, turnId: 'recall-turn' })
          await request.onEvent({ type: 'turn_completed', status: 'completed', threadId, turnId: 'recall-turn' })
          return { turnId: 'recall-turn' } }, interrupt: async () => {} }, close() { rejectUnstarted?.(Object.assign(new Error('Fixture closed'), { code: 'CODEX_APP_SERVER_EXITED' })) } }
    }
    let releaseResume
    const resumeGate = pendingNativeResume ? new Promise(resolve => { releaseResume = resolve }) : null
    t.mock.method(engine, resume, async request => { if (resumeGate) await resumeGate; return launch('resume', request) })
    t.mock.method(engine, start, request => launch('start', request))
    const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8'), ast = parseAst(main)
    const readLedger = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'readSavedStandaloneTabs')
    const readSavedStandaloneTabs = new Function('rendererPrefs', main.slice(readLedger.start, readLedger.end) + '\nreturn readSavedStandaloneTabs')({
      snapshot: () => ({ values: { [fleetTreesStorageKey(computerId)]: world.storage.getItem(fleetTreesStorageKey(computerId)) } }),
    })
    const build = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'buildAgentHost')
    const resolverDeclaration = build.body.body.find(node => node.type === 'VariableDeclaration'
      && node.declarations.some(value => value.id.name === 'legacyResumeOriginResolver'))
    const resolver = new Function('require', 'readSavedStandaloneTabs', 'readStandaloneTranscript', 'accountRegistry', 'process', 'path', 'ACCOUNT_HOME_DIR',
      main.slice(resolverDeclaration.start, resolverDeclaration.end) + '\nreturn legacyResumeOriginResolver')(
      createRequire(new URL('../../shell/main.cjs', import.meta.url)), readSavedStandaloneTabs,
      async () => ({ ok: true, metadata: saved }), registry, { env: {} }, path, directory)
    await damage?.({ world, saved, computerId, nodeId })
    let signedIn = 'yes'
    const hostOptions = { enginePath, defaultCwd: directory, profileRoot: path.parse(directory).root,
      resumeAccountHome: (name, provider) => registry.homeOf({ name, provider }).directory,
      providerSignIn: () => signedIn,
      resumeOriginDirectory: path.join(directory, 'native-origins'),
      freeMemory: () => 64 * 1024 ** 3, legacyResumeOriginResolver: cold50
        ? async () => { throw Object.assign(new Error('Cold 1.0.50 must use its persisted host origin'), { code: 'AGENT_RESUME_IDENTITY_UNAVAILABLE' }) }
        : resolver, automaticTurnStartTimeoutMs: 80,
      sessionAuthority: { toolModeVersion: 1, bind: async () => ({ bound: true, mode: 'owner-host', credential: randomBytes(32).toString('base64url') }), revoke: async () => ({ revoked: true }) },
      accountResolver: async request => {
        selections.push(request)
        const name = request.preferred || 'registered-later'
        return { rotated: true, account: { name, provider, resolvedHome: registry.homeOf({ name, provider }).directory } }
      },
      confinementPlanner: ({ account } = {}) => {
        const home = account ? account.resolvedHome : defaultHome
        const agentHome = path.join(sessions, 'b'.repeat(64), provider, 'standard', account ? 'registered-later' : '@default')
        mkdirSync(agentHome, { recursive: true })
        return { ok: true, isolated: false, tier: 'standard', threadOptions: {}, agentHome,
          ...(provider === 'codex' ? { env: { CODEX_HOME: home } } : { configDir: home,
            ...(provider === 'gemini' ? { agentApiMode: 'Only', acp: { provider, args: [], mcpServers: [] }, env: { GEMINI_CLI_HOME: home } } : {}) }) }
      },
    }
    let host = createAgentHost(hostOptions)
    const authority = { agentId: nodeId,
      role: { id: 'builder', name: 'Builder', owns: 'Answer.', mustNot: 'Change sign-ins.', handoff: 'Person.' },
      agentAuthority: { agentId: nodeId, provider, roleId: 'builder', expectedOrgRevision: 1, expectedRoleRevision: 1 } }
    if (cold50) {
      // Produce the persisted origin through a real host start, discard that
      // host and its maps, then reopen only the saved tree/session selectors.
      const initial = createAgentHost({ ...hostOptions, accountResolver: named ? hostOptions.accountResolver
        : async () => ({ rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }) })
      await initial.startSession({ ...authority, sessionId: 'published48-source', tier: tree.nodes[0].tier })
      saved.nativeSessionId = 'published48-source'
      saved.pinnedHome = named ? namedHome : defaultHome
      await initial.closeAll()
      launches.length = 0; selections.length = 0
      // The upgraded host is newly constructed: in-memory origin maps are empty.
      await host.closeAll(); host = createAgentHost(hostOptions)
      if (removedAccount) writeFileSync(registryFile, '{"accounts":[]}')
    }
    if (changedHome) {
      const replacementHome = path.join(directory, 'changed-home'); mkdirSync(replacementHome)
      writeFileSync(registryFile, JSON.stringify({ accounts: [{ provider, name: 'registered-later', [field]: replacementHome }] }))
      if (!cold50) saved.pinnedHome = namedHome
    }
    if (signedOutAfterStop) signedIn = 'no'
    host.onEvent(packet => { for (const fn of packets) fn(packet) })
    world.bridge.start = async request => { starts.push(request)
      if (neverStarts && request.resumeThreadId) return { ok: false, code: 'CODEX_THREAD_NOT_FOUND',
        startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
      try { return await host.startSession({ ...parseNativeStart(request), ...authority }) }
      catch (error) { refused.push(error.code); return { ok: false, code: error.code, startOutcome: error.startOutcome } } }
    world.bridge.send = request => { sendRequests.push(request); return host.sendTurn(request) }
    world.bridge.sendAutomatic = request => host.sendTurnTracked({ ...request, origin: 'automatic' })
    world.bridge.close = request => host.closeSession(request)
    native = { launches, selections, refused, defaultHome, namedHome, source, oldHome, host, finishLate: () => finishLate?.(), releaseResume }
    t.after(async () => { releaseResume?.(); await host.closeAll(); engine.RESUME_SOURCE_CONTRACT_VERSION = previousContract; rmSync(directory, { recursive: true, force: true }) })
  }
  const view = await mountView(world, { computerId })
  t.after(async () => { releaseSend?.(); await view.destroy(); view.el.remove()
    if (previousOrg) Object.defineProperty(globalThis, 'mcOrg', previousOrg); else delete globalThis.mcOrg
    world.restore()
  })
  const row = () => JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId))).nodes.find(node => node.id === nodeId)
  const open = async () => {
    view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('keydown', { key: 'Enter', shiftKey: true })
    await settle(6)
    return view.el.querySelector('[data-rail-chat-host] .chat')
  }
  const resume = async () => {
    const chat = await open()
    chat.openActions()
    const button = chat.querySelectorAll('.chat-actions-list button').find(row => row.textContent.startsWith('Resume with a fresh agent'))
    assert.ok(button)
    button.dispatch('click')
    await settle(12)
  }
  return { world, view, emit, open, resume, row, starts, sends, sendRequests, native, release: () => releaseSend?.() }
}

for (const nameless of [false, true]) test('a completed fallback seed releases the default-account tree recall queue (nameless: ' + nameless + ')', async t => {
  const f = await mount(t, { early: true, nameless })
  await f.resume()
  assert.equal(f.starts.length, 2)
  assert.equal(f.row().status, 'finished', JSON.stringify(f.row()))
  const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall my word.'; input.dispatch('input')
  chat.querySelector('.chat-send').click()
  await settle(12)
  assert.equal(f.sends.length, 2, chat.textContent)
})

test('published 1.0.48 default tree resumes its owned rollout on the default home after legacy sign-in cleanup and later account registration', async t => {
  const f = await mount(t, { nativeFixture: true })
  await f.resume()
  assert.equal(f.starts.length, 1, JSON.stringify(f.native.refused))
  assert.equal(f.native.launches.length, 1, JSON.stringify(f.native.refused))
  const resumed = f.native.launches[0]
  assert.equal(resumed.kind, 'resume')
  assert.equal(resumed.request.env.CODEX_HOME, f.native.defaultHome)
  assert.equal(resumed.request.resumeSourcePath, f.native.source)
  assert.equal(f.row().status, 'finished')
  const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall my word.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
  await settle(12)
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0].text, /Recall my word/)
})

test('HP-25: early Send during the upgraded default Luna tree native Resume stays queued until that thread opens', async t => {
  const f = await mount(t, { nativeFixture: true, pendingNativeResume: true })
  await f.resume()
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].resumeAccount, null)
  assert.equal(f.starts[0].resumeThreadId, '12345678-1234-4123-8123-123456789abc')
  assert.equal(f.native.launches.length, 0, 'native resume remains deliberately pending')
  const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall while Resume is pending.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
  await settle(12)
  assert.equal(f.sendRequests.length, 0, 'early Send crossed IPC before native Resume settled')
  assert.equal(f.sends.length, 0)
  assert.equal(f.starts.length, 1, 'early Send started another replacement')
  assert.doesNotMatch(chat.textContent, /did not finish closing|fresh one started/i)
  f.native.releaseResume(); await settle(25)
  assert.equal(f.native.launches.length, 1)
  assert.equal(f.native.launches[0].kind, 'resume')
  assert.equal(f.sendRequests.length, 1)
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].threadId, f.starts[0].resumeThreadId)
  assert.match(f.sends[0].text, /^Recall while Resume is pending\./)
})

test('a fresh successor with no native turn acknowledgement stops Thinking, states the specific refusal, and keeps recall queued', async t => {
  const f = await mount(t, { nativeFixture: true, neverStarts: true })
  await f.resume()
  const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall my word.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
  await new Promise(resolve => setTimeout(resolve, 110))
  await settle(8)
  assert.equal(f.row().status, 'failed', JSON.stringify(f.row()))
  assert.match(f.row().statusNote, /did not confirm starting the continuation/i)
  assert.equal(f.sends.length, 1)
  assert.match((await f.open()).textContent, /Recall my word/)
})

test('published 1.0.48 paginated default history keeps its database, while Codex runs on the official default home without a copied sign-in', async t => {
  const f = await mount(t, { nativeFixture: true, paginated: true })
  await f.resume()
  assert.equal(f.native.launches.length, 1, JSON.stringify(f.native.refused))
  assert.equal(f.native.launches[0].request.env.CODEX_HOME, f.native.defaultHome)
  assert.equal(f.native.launches[0].request.resumeDatabaseHome, f.native.oldHome)
  assert.equal(f.native.launches[0].request.resumeSourcePath, f.native.source)
})

test('a recorded named tree account still resumes exactly that account', async t => {
  const f = await mount(t, { nativeFixture: true, named: true })
  await f.resume()
  assert.equal(f.native.launches.length, 1, JSON.stringify(f.native.refused))
  assert.equal(f.native.launches[0].kind, 'resume')
  assert.equal(f.native.launches[0].request.env.CODEX_HOME, f.native.namedHome)
  assert.equal(f.native.launches[0].request.resumeSourcePath, f.native.source)
  assert.ok(f.native.selections.every(request => request.preferred === 'registered-later' && request.exact === true))
})

for (const [label, change, code] of [
  ['missing account', ({ saved }) => { delete saved.account }, 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
  ['another provider', ({ saved }) => { saved.provider = 'claude' }, null],
  ['changed home', ({ saved }) => { saved.pinnedHome = '/fixture/changed-home' }, 'AGENT_RESUME_HOME_UNAVAILABLE'],
  ['another recorded session', ({ saved }) => { saved.nativeSessionId = 'different-recorded-session' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
]) test('legacy tree resume refuses ' + label + ' before a native process or fallback starts', async t => {
  const f = await mount(t, { nativeFixture: true, damage: change })
  await f.resume()
  assert.equal(f.native.launches.length, 0, JSON.stringify(f.native.refused))
  if (code) assert.ok(f.native.refused.includes(code), JSON.stringify(f.native.refused))
})

for (const provider of ['codex', 'claude', 'gemini']) for (const state of ['default-before-registry', 'default-after-registry', 'named-after-registry']) {
  test(provider + ': published 1.0.48 tree upgrade grid / ' + state, async t => {
    const named = state === 'named-after-registry'
    const f = await mount(t, { nativeFixture: true, provider, named, registryAtCreation: state !== 'default-before-registry' })
    await f.resume()
    assert.equal(f.native.launches.length, 1, JSON.stringify(f.native.refused))
    const resumed = f.native.launches[0]
    assert.equal(resumed.kind, 'resume')
    assert.equal(resumed.request.threadId, '12345678-1234-4123-8123-123456789abc')
    assert.equal(provider === 'codex' ? resumed.request.env.CODEX_HOME : resumed.request.configDir || resumed.request.plan.configDir,
      named ? f.native.namedHome : f.native.defaultHome)
    if (provider === 'gemini') assert.equal(resumed.request.plan.env.GEMINI_CLI_HOME, named ? f.native.namedHome : f.native.defaultHome)
    assert.equal(f.starts.length, 1, 'no new conversation is silently substituted')
    const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
    input.value = 'Recall my word.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
    await settle(20)
    assert.equal(f.sends.length, 1)
    assert.equal(f.sends[0].threadId, resumed.request.threadId)
    assert.match((await f.open()).textContent, /CHECKWORD/)
  })
}
for (const provider of ['codex', 'claude', 'gemini']) test(provider + ': a removed recorded named tree account refuses specifically without another account or a fresh conversation', async t => {
  const f = await mount(t, { nativeFixture: true, provider, named: true, removedAccount: true })
  await f.resume()
  assert.equal(f.native.launches.length, 0)
  assert.ok(f.native.refused.includes('AGENT_RESUME_ACCOUNT_UNAVAILABLE'), JSON.stringify(f.native.refused))
  assert.equal(f.starts.length, 1)
  assert.match(f.row().statusNote, /account/i)
})

for (const provider of ['codex', 'claude', 'gemini']) for (const named of [false, true]) {
  test(provider + ': a cold 1.0.50 tree resolves its persisted origin and preserves the ' + (named ? 'named' : 'default') + ' account', async t => {
    const f = await mount(t, { nativeFixture: true, provider, named, cold50: true })
    await f.resume()
    assert.equal(f.starts.length, 1, JSON.stringify(f.native.refused))
    assert.equal(f.native.launches.length, 1, JSON.stringify(f.native.refused))
    const resumed = f.native.launches[0]
    assert.equal(resumed.kind, 'resume')
    assert.equal(resumed.request.threadId, '12345678-1234-4123-8123-123456789abc')
    assert.equal(provider === 'codex' ? resumed.request.env.CODEX_HOME : resumed.request.configDir || resumed.request.plan.configDir,
      named ? f.native.namedHome : f.native.defaultHome)
    assert.equal(f.starts[0].resumeSessionId, 'published48-source')
    assert.equal(f.starts[0].resumeThreadProvider, provider)
    assert.equal(f.starts[0].resumeAccount, named ? 'registered-later' : null)
    const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
    input.value = 'Recall my word.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
    await settle(20)
    assert.equal(f.sends.length, 1)
    assert.equal(f.sends[0].threadId, resumed.request.threadId)
    assert.match((await f.open()).textContent, /CHECKWORD/)
  })
}
for (const provider of ['codex', 'claude', 'gemini']) for (const cold50 of [false, true]) {
  test(provider + ': ' + (cold50 ? 'cold 1.0.50' : '1.0.48') + ' named tree refuses a changed configured home and keeps the conversation', async t => {
    const f = await mount(t, { nativeFixture: true, provider, named: true, cold50, changedHome: true })
    await f.resume()
    assert.equal(f.native.launches.length, 0)
    assert.equal(f.starts.length, 1)
    assert.ok(f.native.refused.includes('AGENT_RESUME_HOME_CHANGED'), JSON.stringify(f.native.refused))
    assert.match(f.row().statusNote, /different sign-in folder/i)
    assert.match(f.row().statusNote, /conversation is kept/i)
    assert.match(f.row().statusNote, /choose the account again/i)
  })
}
for (const provider of ['claude', 'codex', 'gemini']) for (const cold50 of [false, true]) {
  test(`C7-W2: ${provider} ${cold50 ? 'current' : 'legacy'} tree changed empty home refuses specifically before any launch or account probe`, async t => {
    const f = await mount(t, { nativeFixture: true, provider, named: true, cold50, changedHome: true, signedOutAfterStop: true })
    await f.resume()
    assert.equal(f.native.refused.at(-1), 'AGENT_RESUME_HOME_CHANGED')
    assert.match(f.row().statusNote, /different sign-in folder/i)
    assert.match(f.row().statusNote, /conversation is kept/i)
    assert.match(f.row().statusNote, /choose the account again/i)
    assert.match((await f.open()).textContent, /CHECKWORD/)
    assert.equal(f.native.launches.length, 0)
    assert.equal(f.native.selections.length, 0)
    assert.equal(f.sends.length, 0)
  })
}
for (const provider of ['codex', 'claude', 'gemini']) test(provider + ': a cold 1.0.50 tree whose named account was removed refuses before dispatch', async t => {
  const f = await mount(t, { nativeFixture: true, provider, named: true, cold50: true, removedAccount: true })
  await f.resume()
  assert.equal(f.native.launches.length, 0)
  assert.equal(f.starts.length, 1)
  assert.ok(f.native.refused.includes('AGENT_RESUME_ACCOUNT_UNAVAILABLE'), JSON.stringify(f.native.refused))
})
test('late native acceptance and completion after the continuation deadline cannot drain the retained recall', async t => {
  const f = await mount(t, { nativeFixture: true, neverStarts: true })
  await f.resume()
  const chat = await f.open(), input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall my word.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
  await new Promise(resolve => setTimeout(resolve, 110)); await settle(8)
  assert.equal(f.row().status, 'failed')
  await f.native.finishLate(); await settle(20)
  assert.equal(f.sends.length, 1, 'expiration is not authority to send queued words when the late turn completes')
  assert.match((await f.open()).textContent, /Recall my word/)
  assert.match((await f.open()).textContent, /did not confirm starting the continuation/i)
  assert.doesNotMatch((await f.open()).textContent, /safety refusal/i)
})
for (const code of ['AGENT_RESUME_HOME_CHANGED', 'AGENT_AUTOMATIC_TURN_START_UNCONFIRMED']) test(code + ': agent and home surfaces name the refusal and remedy', () => {
  for (const sentence of [unavailableReason(code), engineReason(code)]) {
    assert.doesNotMatch(sentence, /could not work out why|unavailable for an unknown reason/i)
    if (code === 'AGENT_RESUME_HOME_CHANGED') {
      assert.match(sentence, /different sign-in folder/i); assert.match(sentence, /conversation is kept/i)
      assert.match(sentence, /choose the account again/i)
    } else {
      assert.match(sentence, /did not confirm starting the continuation/i); assert.match(sentence, /stop/i)
    }
  }
})
test('the retained queue explains the absent native acknowledgement and the Stop remedy', () => {
  assert.match(QUEUE_PANEL.heldReasons.AGENT_AUTOMATIC_TURN_START_UNCONFIRMED, /did not confirm starting the continuation/i)
  assert.match(QUEUE_PANEL.heldReasons.AGENT_AUTOMATIC_TURN_START_UNCONFIRMED, /message is kept/i)
  assert.match(QUEUE_PANEL.heldReasons.AGENT_AUTOMATIC_TURN_START_UNCONFIRMED, /stop/i)
})

test('native acceptance before the deadline waits for its save boundary instead of expiring or retransmitting', async t => {
  const f = await mount(t, { nativeFixture: true })
  await f.resume()
  let releaseSave, settled = false
  const unlisten = f.native.host.onAcceptedPrompt(() => new Promise(resolve => { releaseSave = resolve }))
  const sending = f.native.host.sendTurnTracked({ sessionId: f.row().sessionId, text: 'Continue once.', origin: 'automatic' })
  sending.then(() => { settled = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 110))
    assert.equal(typeof releaseSave, 'function', 'the provider really accepted this turn')
    assert.equal(settled, false, 'a slow save is not a missing native acknowledgement')
    assert.equal(f.sends.length, 1)
  } finally { releaseSave?.(); unlisten() }
  assert.equal((await sending).deliveryDisposition, 'accepted')
})
test('invalid automatic acknowledgement bounds refuse by name before provider work', async () => {
  const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  for (const automaticTurnStartTimeoutMs of [0, -1, NaN, 1.5, 3_600_001]) {
    assert.throws(() => createAgentHost({ enginePath, automaticTurnStartTimeoutMs }), { code: 'AGENT_HOST_INVALID_ARGUMENT' })
  }
  for (const automaticTurnStartTimeoutMs of [1, 60_000, 3_600_000]) {
    await createAgentHost({ enginePath, automaticTurnStartTimeoutMs }).closeAll()
  }
})

test('tree origin lookup refuses wrong ledger ownership, version, shape, size, duplicate node and changed session selectors', async () => {
  const location = { computerId: 'fixture-computer', nodeId: 'fixture-tree-node' }
  const request = { sessionId: 'saved-session', threadId: 'saved-thread', provider: 'codex', account: null, agentId: location.nodeId, transcript: location }
  const metadata = { ...location, threadId: request.threadId, provider: request.provider, account: null }
  const node = { id: location.nodeId, sessionId: request.sessionId }
  const ledger = { version: 1, computerId: location.computerId, nodes: [node] }
  const cases = [
    [null, 'AGENT_RESUME_IDENTITY_UNAVAILABLE'], ['{', 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
    [JSON.stringify({ ...ledger, version: 2 }), 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
    [JSON.stringify({ ...ledger, computerId: 'another-computer' }), 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
    [JSON.stringify({ ...ledger, nodes: {} }), 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
    [JSON.stringify({ ...ledger, nodes: Array.from({ length: 4097 }, () => node) }), 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
    [JSON.stringify(ledger) + ' '.repeat(64 * 1024 * 1024), 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
    [JSON.stringify({ ...ledger, nodes: [node, node] }), 'AGENT_RESUME_IDENTITY_MISMATCH'],
    [JSON.stringify({ ...ledger, nodes: [{ ...node, sessionId: 'another-session' }] }), 'AGENT_RESUME_IDENTITY_MISMATCH'],
  ]
  for (const [raw, code] of cases) {
    let homeLookups = 0
    const resolve = createLegacyResumeOriginResolver({ readTabs: () => null, readTrees: () => raw,
      readTranscript: async () => ({ ok: true, metadata }), accountHome: () => { homeLookups++; return os.tmpdir() },
      defaultHome: () => { homeLookups++; return os.tmpdir() } })
    await assert.rejects(resolve(request), { code })
    assert.equal(homeLookups, 0, 'unverified identity cannot reach an account home lookup')
  }
})

test('a transcript native session that contradicts its canonical tree selector refuses before home lookup', async () => {
  const transcript = { computerId: 'fixture-computer', nodeId: 'fixture-tree' }
  const resolver = createLegacyResumeOriginResolver({
    readTrees: () => JSON.stringify({ version: 1, computerId: transcript.computerId, nodes: [{ id: transcript.nodeId, sessionId: 'saved-session' }] }),
    readTranscript: async () => ({ ok: true, metadata: { ...transcript, nativeSessionId: 'contradictory-session', threadId: 'saved-thread', provider: 'codex', account: null } }),
    defaultHome: () => { throw new Error('unverified identity reached a home lookup') },
  })
  await assert.rejects(resolver({ sessionId: 'saved-session', threadId: 'saved-thread', provider: 'codex', account: null,
    agentId: transcript.nodeId, transcript }), { code: 'AGENT_RESUME_IDENTITY_MISMATCH' })
})
