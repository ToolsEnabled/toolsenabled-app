import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { reopenFixtureEngine } from './helpers/reopen-fixture-engine.mjs'
import { mountComputers, settle, COMPUTER_ID } from './helpers/t1308-computers-fixture.mjs'
import { STANDALONE_TABS_PREFIX } from '../../src/standalone-tab-ledger.js'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { mountChatTakeover } from '../../src/home-chat-takeover.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { parseAst } from 'rollup/parseAst'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createLegacyResumeOriginResolver } = require('../../shell/legacy-resume-origin.cjs')
const { createAccountRegistryStore } = require('../../shell/account-registry.cjs')
const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const planner = require('./fixtures/confined-engine/src/lib/agent-session-confinement.js')
const { codexConfigOverrideArgs } = require('../../../engine/src/lib/agent-session-confinement.js')
const seatId = 'standalone-12345678-1234-4123-8123-123456789abc'
const owner = { version: 1, ownerId: 'fixture-owner', currentEpoch: 'fixture-epoch', kind: 'local' }

async function machine(t, { provider = 'codex', named = true, restarted = false, beforeReopen = null, bindReceipt = null, legacy = false, legacyDamage = null, accountLookupDamage = null, published48 = false, continuationDamage = null, registryAtCreation = false, unverifiedAccountHome = false, changedDefaultHome = false, signedOutAfterStop = false } = {}) {
  if (published48) legacy = true
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reopen-binding-'))
  const originalHome = provider === 'gemini' && !named ? directory : path.join(directory, published48 ? (provider === 'claude' ? '.claude' : provider === 'gemini' ? 'gemini-account-home' : '.codex') : 'original-home'), laterHome = path.join(directory, 'later-home')
  if (originalHome !== directory) mkdirSync(originalHome); mkdirSync(laterHome)
  let home = originalHome, host, capture, savedTabs, canonicalTabs, signedIn = 'yes'
  const registryFile = path.join(directory, 'fixture-accounts.json')
  const accountRecord = { accounts: named ? [{ provider, name: 'original-account',
    [provider === 'codex' ? 'profileDir' : provider === 'gemini' ? 'homeDir' : 'configDir']: originalHome }] : [] }
  if (registryAtCreation && !named) accountRecord.accounts = [{ provider: provider === 'claude' ? 'codex' : 'claude',
    name: 'registered-earlier-other-provider', [provider === 'claude' ? 'profileDir' : 'configDir']: laterHome }]
  writeFileSync(registryFile, JSON.stringify(accountRecord))
  const registry = createAccountRegistryStore({ file: registryFile, homedir: () => directory })
  const { createLegacyStandaloneTranscriptReader, readSavedStandaloneContinuation } = require('../../shell/legacy-standalone-identity.cjs')
  let readStandaloneTranscript = createLegacyStandaloneTranscriptReader({
    readTranscript: request => store.read(request), readTabs: () => canonicalTabs,
    readContinuation: sessionId => readSavedStandaloneContinuation({ file: continuationFile, sessionId, continuationModule }),
  })
  let resolveLegacyOrigin = createLegacyResumeOriginResolver({
    readTabs: () => canonicalTabs, readTranscript: request => readStandaloneTranscript(request),
    accountHome: (name, provider) => registry.homeOf({ name, provider }).directory,
    defaultHome: () => legacy ? originalHome : home,
  })
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const mainAst = parseAst(main)
  if (published48) {
    // Exercise both actual shell consumers: the renderer's transcript read and
    // the host's independent identity/account re-read before native dispatch.
    const selected = mainAst.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'readSavedStandaloneTabs'
      || node.type === 'VariableDeclaration' && node.declarations.some(value => value.id.name === 'readStandaloneTranscript'))
    readStandaloneTranscript = new Function('require', 'nodeTranscripts', 'rendererPrefs',
      'resolveServicesRootForAccounts', 'resolveCapabilityRoot', 'path',
      selected.map(node => main.slice(node.start, node.end)).join('\n') + '\nreturn readStandaloneTranscript')(
      createRequire(new URL('../../shell/main.cjs', import.meta.url)),
      { read: request => store.read(request) },
      { snapshot: () => ({ values: { [STANDALONE_TABS_PREFIX + COMPUTER_ID]: canonicalTabs } }) },
      () => directory, () => fileURLToPath(new URL('../../../engine', import.meta.url)), path)
    const build = mainAst.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'buildAgentHost')
    const resolver = build.body.body.find(node => node.type === 'VariableDeclaration'
      && node.declarations.some(value => value.id.name === 'legacyResumeOriginResolver'))
    resolveLegacyOrigin = new Function('require', 'readSavedStandaloneTabs', 'readStandaloneTranscript',
      'accountRegistry', 'process', 'path', 'ACCOUNT_HOME_DIR',
      main.slice(resolver.start, resolver.end) + '\nreturn legacyResumeOriginResolver')(
      createRequire(new URL('../../shell/main.cjs', import.meta.url)), () => canonicalTabs,
      readStandaloneTranscript, registry, { env: {} }, path, directory)
  }
  const launches = [], nativeCloses = [], starts = [], sends = [], selections = [], bindings = [], refusals = [], listeners = new Set()
  const tier = provider === 'claude' ? (published48 ? 'claude-sonnet-5' : 'claude-sonnet') : provider === 'gemini' ? 'gemini' : 'astra'
  const { enginePath, engine, start, resume } = reopenFixtureEngine(directory, provider)
  const adapter = { sendTurn: async request => { sends.push(request); return { turnId: 'fixture-turn-' + sends.length } },
    interrupt: async () => {}, answerApproval() {} }
  const native = (kind, request) => {
    launches.push({ kind, request })
    return { adapter, threadId: kind === 'resume' ? request.threadId : 'saved-provider-thread',
      ...(kind === 'resume' ? { resumed: { turns: [], turnCount: 0 } } : {}), close() { nativeCloses.push(kind) } }
  }
  t.mock.method(engine, start, async request => native('start', request))
  t.mock.method(engine, resume, async request => native('resume', request))
  const previousArgs = planner.codexConfigOverrideArgs
  planner.codexConfigOverrideArgs = codexConfigOverrideArgs
  let store = createNodeTranscriptStore({ directory: path.join(directory, 'transcripts') })
  const openHost = () => {
    host = createAgentHost({ enginePath, defaultCwd: directory,
      profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(directory).root,
      resumeOriginDirectory: path.join(directory, 'native-origins'),
      legacyResumeOriginResolver: resolveLegacyOrigin,
      resumeAccountHome: (name, provider) => registry.homeOf({ name, provider }).directory,
      providerSignIn: () => signedIn,
      freeMemory: () => 64 * 1024 ** 3,
      accountResolver: async request => {
        selections.push(request)
        if (request.preferred) await accountLookupDamage?.({ registryFile, accountRecord, laterHome, provider })
        if (request.preferred || named) {
          const name = request.preferred || 'original-account'
          return { rotated: true, account: { name, provider, resolvedHome: request.preferred && unverifiedAccountHome
            ? unverifiedAccountHome === true ? undefined : unverifiedAccountHome
            : registry.homeOf({ name, provider }).directory } }
        }
        return home === laterHome ? { rotated: true, account: { name: 'registered-later', provider, resolvedHome: home } }
          : { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }
      },
      confinementPlanner: ({ account } = {}) => {
        const officialHome = account?.resolvedHome || home
        return { ok: true, tier: 'unrestricted', isolated: false, threadOptions: {},
          account: account?.name || null, ...(provider !== 'codex' ? { configDir: officialHome,
            ...(provider === 'gemini' ? { agentApiMode: 'Only', acp: { provider, args: [], mcpServers: [] }, env: { GEMINI_CLI_HOME: officialHome } } : {}) }
            : { env: { CODEX_HOME: officialHome }, codexConfig: { sqlite_home: officialHome }, codexArgs: codexConfigOverrideArgs({ sqlite_home: officialHome }) }) }
      },
    })
    capture = createNodeTranscriptCapture({ store, sessionMetadata: id => host.sessionTranscriptMetadata(id) })
    host.onEvent(packet => { capture.packet(packet); for (const listener of listeners) listener(packet) })
    return host
  }
  openHost()
  const original = await host.startSession({ sessionId: 'saved-native-source', tier })
  if (!legacy) capture.bind({ sessionId: original.sessionId, computerId: COMPUTER_ID, nodeId: seatId, authoritative: true })
  savedTabs = JSON.stringify({ v: 1, tabs: [
    { id: seatId, name: 'Agent 1', tier, effort: null, openedAt: 1, sessionId: original.sessionId },
  ] })
  canonicalTabs = savedTabs
  const legacyMetadata = published48 ? {} : { threadId: original.threadId, provider, account: original.account }
  const continuationFile = path.join(directory, 'agent-continuations.sqlite')
  const continuationModule = require('../../../engine/src/lib/agent-continuation-state.js')
  if (published48) {
    // Published 1.0.48's window start remembered this v1 descriptor. Its
    // standalone transcript bind was non-authoritative and saved no native metadata.
    const continuation = continuationModule.createContinuationState({ file: continuationFile })
    const descriptor = { sessionId: original.sessionId, resumeThreadId: original.threadId,
      resumeThreadProvider: provider, resumeAccount: original.account, tier, cwd: directory,
      roleBinding: { id: 'worker', agentId: seatId, expectedOrgRevision: 0, expectedRoleRevision: 0 } }
    await continuationDamage?.({ descriptor, legacyMetadata })
    const row = continuation.track(descriptor)
    continuation.stop(row.key)
    continuation.close()
  }
  await legacyDamage?.({ legacyMetadata, registryFile, accountRecord, originalHome, laterHome,
    replaceTabs: value => { canonicalTabs = value } })
  await store.append({ computerId: COMPUTER_ID, nodeId: seatId,
    ...(legacy ? { metadata: legacyMetadata } : {}), entries: [
    { id: 'old-person', who: 'you', text: 'Remember CHECKWORD.', at: 1 },
    { id: 'old-agent', who: 'agent', text: 'CHECKWORD', at: 2 },
  ] })
  await host.closeSession({ sessionId: original.sessionId })
  await capture.shutdown()
  if (signedOutAfterStop) signedIn = 'no'
  if (legacy) rmSync(path.join(directory, 'native-origins'), { recursive: true, force: true })
  await beforeReopen?.({ directory, originDirectory: path.join(directory, 'native-origins'), original, registryFile })
  if (restarted) {
    store = createNodeTranscriptStore({ directory: path.join(directory, 'transcripts') })
    openHost()
  }
  else capture = createNodeTranscriptCapture({ store, sessionMetadata: id => host.sessionTranscriptMetadata(id) })
  home = provider === 'claude' && !named && !changedDefaultHome ? originalHome : laterHome
  if (published48 && !named) {
    accountRecord.accounts = [{ provider, name: 'registered-later', [provider === 'codex' ? 'profileDir' : provider === 'gemini' ? 'homeDir' : 'configDir']: laterHome }]
    writeFileSync(registryFile, JSON.stringify(accountRecord))
  }
  const bridge = {
    availability: async request => host.startableTiers(request), confinement: async () => ({ ok: true, tier: 'unrestricted' }),
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    ownerContext: async () => owner, onOwnerContextChanged: () => () => {},
    start: async request => {
      starts.push(request)
      try { return await host.startSession(request) } catch (error) { refusals.push(error.code); return { ok: false, code: error.code } }
    },
    send: request => host.sendTurn(request), close: request => host.closeSession(request),
    interrupt: request => host.interruptTurn(request),
  }
  // Invoke the current shell's actual IPC listener without starting Electron.
  const declaration = mainAst.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression' && node.expression.arguments[0]?.value === 'mc-transcripts:bind')
  assert.ok(declaration, 'the real transcript bind IPC must be available')
  let bindIpc
  new Function('ipcMain', 'trustedFleetProfileSender', 'transcriptCapture', 'prefsRefusal', 'transcriptRefusalCode',
    main.slice(declaration.start, declaration.end))(
    { handle: (_channel, fn) => { bindIpc = fn } }, () => true, capture,
    () => ({ ok: false, error: { code: 'MC_PREFS_SENDER_REFUSED' } }),
    error => error.code?.startsWith('MC_TRANSCRIPT_') ? error.code : 'MC_TRANSCRIPT_STORAGE_FAILED')
  const loop = parseAst(main).body.find(node => node.type === 'ForOfStatement'
    && node.right.type === 'ArrayExpression' && node.right.elements.some(value => value.value === 'commitArchive'))
  assert.ok(loop, 'the real transcript read IPC must be available')
  let readIpc
  new Function('ipcMain', 'trustedFleetProfileSender', 'nodeTranscripts', 'withConversationStorageState',
    'prefsRefusal', 'transcriptRefusalCode', 'readStandaloneTranscript', main.slice(loop.start, loop.end))(
    { handle: (channel, fn) => { if (channel === 'mc-transcripts:read') readIpc = fn } },
    () => true, store, value => value, () => ({ ok: false }),
    error => error.code || 'MC_TRANSCRIPT_STORAGE_FAILED', readStandaloneTranscript)
  const transcripts = {
    list: request => store.list(request),
    read: async request => {
      const answer = await readIpc({}, request)
      if (answer.metadata?.resumeIdentityError) refusals.push(answer.metadata.resumeIdentityError)
      return answer
    },
    append: request => store.append(request),
    bind: async request => { bindings.push(request); return bindReceipt || bindIpc({}, request) },
    release: request => capture.release(request), onError: () => () => {},
  }
  t.after(async () => {
    await host.closeAll(); await capture.shutdown()
    if (previousArgs) planner.codexConfigOverrideArgs = previousArgs; else delete planner.codexConfigOverrideArgs
    rmSync(directory, { recursive: true, force: true })
  })
  const fixture = await mountComputers(t, { nodes: [{ id: 'tree-node', role: 'worker' }],
    agents: [{ id: 'controller', role: 'controller', enabled: true },
      { id: seatId, name: 'Agent 1', role: 'worker', enabled: true, provider }],
    seed: storage => {
      storage.setItem('mc.write.agent-session', 'enabled')
      storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, savedTabs)
      Object.assign(window.mcAgent, bridge)
      window.mcTranscripts = transcripts
    } })
  await settle()
  return { fixture, original, originalHome, launches, nativeCloses, starts, sends, selections, bindings, refusals, store, host, directory, continuationFile, continuationModule, bindingFor: id => capture.bindingFor(id) }
}

async function sendSaved(f) {
  const record = f.fixture.graph.workspace.standalone.get(seatId)
  assert.ok(record, 'saved Agent 1 must be restored')
  const chat = record.chatPanel.querySelector('[data-chat-panel]')
  const input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall my saved word.'
  input.dispatch('input')
  chat.querySelector('.chat-send').click()
  await settle()
  return { record, input }
}

for (const provider of ['claude', 'codex', 'gemini']) for (const legacy of [false, true]) {
  test(`C7-W2: ${provider} ${legacy ? 'legacy' : 'current'} standalone changed empty home refuses specifically before any launch or account probe`, async t => {
    const f = await machine(t, { provider, legacy, named: true, restarted: true, signedOutAfterStop: true,
      legacyDamage: ({ legacyMetadata, originalHome }) => { legacyMetadata.pinnedHome = originalHome },
      beforeReopen: ({ registryFile }) => {
        const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
        registry.accounts[0][provider === 'claude' ? 'configDir' : provider === 'codex' ? 'profileDir' : 'homeDir'] = path.join(path.dirname(registryFile), 'later-home')
        writeFileSync(registryFile, JSON.stringify(registry))
      } })
    const { record } = await sendSaved(f)
    assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_CHANGED', record.chatPanel.textContent)
    assert.match(record.chatPanel.textContent, /different sign-in folder/i)
    assert.match(record.chatPanel.textContent, /conversation is kept/i)
    assert.match(record.chatPanel.textContent, /choose the account again/i)
    assert.match(record.chatPanel.textContent, /CHECKWORD/)
    assert.equal(f.launches.length, 1, 'only the initial saved conversation launched')
    assert.equal(f.selections.length, 1, 'resume home verification must precede account probes')
    assert.equal(f.sends.length, 0)
  })
}

for (const provider of ['codex', 'claude', 'gemini']) for (const named of [false, true]) {
  test(`${provider}: clean reopen resumes the saved ${named ? 'named' : 'default'} account and home before its first send`, async t => {
    const f = await machine(t, { provider, named, restarted: true })
    const { record } = await sendSaved(f)
    assert.equal(f.sends.length, 1, record.chatPanel.textContent)
    const resumed = f.launches.find(row => row.kind === 'resume')
    assert.ok(resumed)
    assert.equal(f.launches.filter(row => row.kind === 'start').length, 1, 'no replacement conversation may be silently started')
    assert.equal(resumed.request.threadId, f.original.threadId)
    assert.equal(provider !== 'codex' ? resumed.request.configDir || resumed.request.plan.configDir : resumed.request.env.CODEX_HOME, f.originalHome)
    if (provider === 'codex') {
      assert.equal(resumed.request.plan.codexConfig.sqlite_home, f.originalHome)
      assert.ok(resumed.request.plan.codexArgs.includes('sqlite_home=' + JSON.stringify(f.originalHome)))
    }
    assert.equal(record.session.snapshot().account, named ? 'original-account' : null)
    assert.equal(f.starts[0].resumeSessionId, f.original.sessionId)
    assert.equal(f.starts[0].resumeAccount || null, f.original.account)
    assert.equal(Object.hasOwn(f.starts[0], 'historyHandoff'), false)
    assert.equal(f.bindings.length, 1)
    assert.equal(f.bindings[0].nodeId, seatId)
    assert.equal(f.sends[0].threadId, f.original.threadId)
    const saved = await f.store.read({ computerId: COMPUTER_ID, nodeId: seatId })
    assert.equal(saved.metadata.nativeSessionId, f.starts[0].sessionId, 'the shell must persist the newly confirmed native session selector')
    assert.equal(saved.metadata.threadId, f.original.threadId)
    assert.equal(f.selections.length, named ? 2 : 1, 'default resume must not choose the later account')
  })
}


for (const provider of ['codex', 'claude', 'gemini']) for (const named of [false, true]) {
  test(`${provider}: a legacy tab with native transcript metadata resumes its recorded ${named ? 'named' : 'default'} account through the configured home`, async t => {
    const f = await machine(t, { provider, named, restarted: true, legacy: true })
    const { record } = await sendSaved(f)
    assert.equal(f.sends.length, 1, record.chatPanel.textContent)
    const resumed = f.launches.find(row => row.kind === 'resume')
    assert.ok(resumed, 'upgrade must resume the provider conversation with its words')
    assert.equal(resumed.request.threadId, f.original.threadId)
    assert.equal(f.sends[0].threadId, f.original.threadId)
    assert.match(record.chatPanel.textContent, /Remember CHECKWORD\./, 'the saved person message remains visible after upgrade')
    assert.match(record.chatPanel.textContent, /CHECKWORD/, 'the saved assistant words remain visible after upgrade')
    assert.equal(provider !== 'codex' ? resumed.request.configDir || resumed.request.plan.configDir : resumed.request.env.CODEX_HOME, f.originalHome)
    assert.equal(record.session.snapshot().account, named ? 'original-account' : null)
    assert.equal(f.launches.filter(row => row.kind === 'start').length, 1, 'upgrade must never seed a fresh conversation silently')
    assert.equal(Object.hasOwn(f.starts[0], 'historyHandoff'), false)
    assert.deepEqual(f.starts[0].resumeTranscript, { computerId: COMPUTER_ID, nodeId: seatId })
    assert.equal(f.selections.length, named ? 2 : 1, 'a recorded default account must bypass later named-account selection')
    const originFiles = readdirSync(path.join(f.directory, 'native-origins'))
    assert.equal(originFiles.filter(file => file.endsWith('.json')).length, 1, 'the upgraded native session persists its observed home for its next quit')
  })
}

for (const provider of ['codex', 'claude']) for (const named of [false, true]) {
  test(`${provider}: published 1.0.48 standalone layout resumes the exact ${named ? 'named' : 'default'} account conversation`, async t => {
    const f = await machine(t, { provider, named, restarted: true, published48: true })
    const before = await f.store.read({ computerId: COMPUTER_ID, nodeId: seatId })
    assert.deepEqual(Object.keys(before.metadata).sort(), ['computerId', 'nodeId', 'revision', 'savedAt'],
      'the persisted metadata matches the tester shape export; no native identity was added to the fixture')
    assert.equal(before.metadata.threadId, undefined, 'published standalone transcripts had no native thread field')
    assert.equal(before.metadata.provider, undefined)
    assert.equal(before.metadata.account, undefined)
    const { record } = await sendSaved(f)
    assert.equal(f.sends.length, 1, record.chatPanel.textContent)
    const resumed = f.launches.find(row => row.kind === 'resume')
    assert.ok(resumed, 'the native conversation must resume, never a speech-seeded replacement')
    assert.equal(resumed.request.threadId, f.original.threadId)
    assert.equal(f.sends[0].threadId, f.original.threadId)
    assert.equal(record.session.snapshot().account, named ? 'original-account' : null)
    assert.equal(provider !== 'codex' ? resumed.request.configDir || resumed.request.plan.configDir : resumed.request.env.CODEX_HOME, f.originalHome)
    assert.equal(f.launches.filter(row => row.kind === 'start').length, 1)
    assert.equal(Object.hasOwn(f.starts[0], 'historyHandoff'), false)
    assert.equal(f.starts[0].resumeSessionId, f.original.sessionId)
    if (provider === 'claude') assert.equal(f.starts[0].tier, 'claude-sonnet-5', 'the pinned model survives the upgrade')
    assert.match(record.chatPanel.textContent, /Remember CHECKWORD\./)
    const continuation = f.continuationModule.createContinuationState({ file: f.continuationFile })
    const row = continuation.get(f.continuationModule.keyFor({ sessionId: f.original.sessionId }))
    continuation.close()
    assert.equal(row.status, 'stopped', 'identity lookup must never revive or claim automatic work')
    assert.equal(row.revision, 2, 'identity lookup must not rewrite the saved continuation')
  })
}

for (const [layout, options] of [['current', {}], ['legacy native', { legacy: true }], ['published 1.0.48', { published48: true }]]) {
  test('claude: ' + layout + ' default conversation refuses a changed configured default home', async t => {
    const f = await machine(t, { provider: 'claude', named: false, restarted: true, changedDefaultHome: true, ...options })
    const { record, input } = await sendSaved(f)
    assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_UNAVAILABLE')
    assert.equal(f.launches.length, 1, 'a changed home must not dispatch native resume or a fresh conversation')
    assert.equal(f.sends.length, 0)
    assert.equal(input.value, 'Recall my saved word.')
    assert.match(record.chatPanel.textContent, /CHECKWORD/)
  })
}

for (const provider of ['codex', 'claude']) for (const [damage, change, code] of [
  ['another seat', ({ descriptor }) => { descriptor.roleBinding.agentId = 'another-seat' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  ['another transcript thread', ({ legacyMetadata }) => { legacyMetadata.threadId = 'contradictory-thread' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  ['another transcript provider', ({ legacyMetadata }) => { legacyMetadata.provider = 'grok' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  ['another transcript account', ({ legacyMetadata }) => { legacyMetadata.account = 'other-account' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  ['missing provider thread', ({ descriptor }) => { descriptor.resumeThreadId = null }, 'AGENT_RESUME_IDENTITY_UNAVAILABLE'],
]) test(`${provider}: published standalone refuses ${damage} before native acceptance`, async t => {
  const f = await machine(t, { provider, restarted: true, published48: true, continuationDamage: change })
  const { record, input } = await sendSaved(f)
  assert.equal(f.refusals.at(-1), code)
  assert.equal(f.starts.length, 0, 'contradictory identity must be refused before admission')
  assert.equal(f.launches.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(input.value, 'Recall my saved word.')
  assert.match(record.chatPanel.textContent, /CHECKWORD/)
  assert.match(record.chatPanel.textContent, code.endsWith('MISMATCH')
    ? /does not match its original agent or account/ : /no verified native session identity/)
  assert.doesNotMatch(record.chatPanel.textContent, /could not work out why/)
})

for (const [damage, code, change] of [
  ['removed account', 'AGENT_RESUME_ACCOUNT_UNAVAILABLE', ({ registryFile }) => writeFileSync(registryFile, '{"accounts":[]}')],
  ['changed recorded home', 'AGENT_RESUME_HOME_CHANGED', ({ legacyMetadata, laterHome }) => { legacyMetadata.home = laterHome }],
  ['wrong saved account', 'AGENT_RESUME_ACCOUNT_UNAVAILABLE', ({ legacyMetadata }) => { legacyMetadata.account = 'removed-account' }],
  ['missing saved account', 'AGENT_RESUME_IDENTITY_UNAVAILABLE', ({ legacyMetadata }) => { delete legacyMetadata.account }],
  ['changed tab owner', 'AGENT_RESUME_IDENTITY_MISMATCH', ({ replaceTabs }) => replaceTabs('{"v":1,"tabs":[]}')],
  ['oversized tab record', 'AGENT_RESUME_IDENTITY_UNAVAILABLE', ({ replaceTabs }) => replaceTabs('{"v":1,"tabs":[]}' + ' '.repeat(65537))],
]) test(`1.0.48 upgrade refuses ${damage} by name and retains its unsent draft`, async t => {
  const f = await machine(t, { restarted: true, legacy: true, legacyDamage: change })
  const { record, input } = await sendSaved(f)
  assert.equal(f.sends.length, 0)
  assert.equal(f.launches.length, 1, 'no resumed or replacement provider starts on unverified identity/home')
  assert.equal(input.value, 'Recall my saved word.')
  assert.equal(f.refusals.at(-1), code)
  if (code === 'AGENT_RESUME_IDENTITY_MISMATCH') assert.match(record.chatPanel.textContent, /does not match its original agent or account/)
  if (code === 'AGENT_RESUME_IDENTITY_UNAVAILABLE') assert.match(record.chatPanel.textContent, /no verified native session identity/)
  assert.doesNotMatch(record.chatPanel.textContent, /could not work out why/)
})



test('1.0.48 upgrade rechecks its configured home after account selection and before provider dispatch', async t => {
  const f = await machine(t, { legacy: true, restarted: true,
    accountLookupDamage: ({ registryFile, accountRecord, laterHome }) => {
      accountRecord.accounts[0].profileDir = laterHome
      writeFileSync(registryFile, JSON.stringify(accountRecord))
    } })
  const { input } = await sendSaved(f)
  assert.equal(f.launches.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_CHANGED')
  assert.equal(input.value, 'Recall my saved word.')
})

test('legacy origin lookup names a transcript read failure without printing its detail', async () => {
  const resolve = createLegacyResumeOriginResolver({
    readTabs: () => JSON.stringify({ v: 1, tabs: [{ id: seatId, sessionId: 'old-session' }] }),
    readTranscript: async () => { throw new Error('synthetic private file diagnostic') },
    accountHome: () => os.tmpdir(), defaultHome: () => os.tmpdir(),
  })
  await assert.rejects(resolve({ sessionId: 'old-session', threadId: 'old-thread', provider: 'codex',
    account: null, agentId: seatId, transcript: { computerId: COMPUTER_ID, nodeId: seatId } }),
    error => error.code === 'AGENT_RESUME_IDENTITY_UNAVAILABLE' && !error.message.includes('private file diagnostic'))
})

test('legacy origin lookup verifies saved identities before resolving any sign-in home', async () => {
  const transcript = { computerId: COMPUTER_ID, nodeId: seatId }
  const request = { sessionId: 'old-session', threadId: 'old-thread', provider: 'codex', account: null, agentId: seatId, transcript }
  const saved = { ...transcript, threadId: 'old-thread', provider: 'codex', account: null }
  let lookups = 0
  const resolve = createLegacyResumeOriginResolver({
    readTabs: () => JSON.stringify({ v: 1, tabs: [{ id: seatId, sessionId: 'old-session' }] }),
    readTranscript: async () => ({ ok: true, metadata: saved }),
    accountHome: () => { lookups++; return os.tmpdir() }, defaultHome: () => { lookups++; return os.tmpdir() },
  })
  for (const change of [{ sessionId: 'wrong-session' }, { threadId: 'wrong-thread' },
    { provider: 'claude' }, { account: 'wrong-account' }, { agentId: 'wrong-agent' }]) {
    await assert.rejects(resolve({ ...request, ...change }), { code: 'AGENT_RESUME_IDENTITY_MISMATCH' })
  }
  assert.equal(lookups, 0, 'a different identity cannot query or select an account home')
})

test('legacy origin lookup names unreadable, oversized and indeterminate saved records', async () => {
  const transcript = { computerId: COMPUTER_ID, nodeId: seatId }
  const request = { sessionId: 'old-session', threadId: 'old-thread', provider: 'codex', account: null, agentId: seatId, transcript }
  const saved = { ...transcript, threadId: 'old-thread', provider: 'codex', account: null }
  const tab = JSON.stringify({ v: 1, tabs: [{ id: seatId, sessionId: 'old-session' }] })
  const resolve = (tabs, answer) => createLegacyResumeOriginResolver({ readTabs: () => tabs,
    readTranscript: async () => answer, accountHome: () => os.tmpdir(), defaultHome: () => os.tmpdir() })(request)
  for (const tabs of [null, '{', tab + ' '.repeat(65537), JSON.stringify({ v: 2, tabs: [] }),
    JSON.stringify({ v: 1, tabs: Array.from({ length: 65 }, () => ({ id: seatId })) })]) {
    await assert.rejects(resolve(tabs, { ok: true, metadata: saved }), { code: 'AGENT_RESUME_IDENTITY_UNAVAILABLE' })
  }
  for (const answer of [{ ok: false }, { ok: true, durable: false, metadata: saved },
    { ok: true, metadata: { ...saved, closed: true } }, { ok: true, metadata: { ...saved, threadId: '' } },
    { ok: true, metadata: { ...saved, provider: 'unverified-provider' } },
    { ok: true, metadata: { ...saved, account: undefined } }]) {
    await assert.rejects(resolve(tab, answer), { code: 'AGENT_RESUME_IDENTITY_UNAVAILABLE' })
  }
  await assert.rejects(resolve(JSON.stringify({ v: 1, tabs: [{ id: seatId }, { id: seatId }] }),
    { ok: true, metadata: saved }), { code: 'AGENT_RESUME_IDENTITY_MISMATCH' })
})

test('legacy origin lookup refuses relative or changed home bindings, including a change after lookup', async () => {
  const transcript = { computerId: COMPUTER_ID, nodeId: seatId }
  const request = { sessionId: 'old-session', threadId: 'old-thread', provider: 'codex', account: null, agentId: seatId, transcript }
  let home = os.tmpdir()
  const resolve = metadata => createLegacyResumeOriginResolver({
    readTabs: () => JSON.stringify({ v: 1, tabs: [{ id: seatId, sessionId: 'old-session' }] }),
    readTranscript: async () => ({ ok: true, metadata: { ...transcript, threadId: 'old-thread', provider: 'codex', account: null, ...metadata } }),
    accountHome: () => home, defaultHome: () => home,
  })(request)
  for (const metadata of [{ home: 'relative' }, { home: path.join(home, 'different') }, { databaseHome: 'relative' }]) {
    await assert.rejects(resolve(metadata), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
  }
  home = 'relative'
  await assert.rejects(resolve({}), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
  home = os.tmpdir()
  const origin = await resolve({ home })
  home = path.join(home, 'different')
  assert.throws(() => origin.assertCurrent(), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
})

test('the real shell parser accepts only a saved conversation location beside its source selector', () => {
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const ast = parseAst(source)
  const declarations = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'boundedAgentModel', 'parseAgentStart']
    .map(name => { const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name); return source.slice(node.start, node.end) })
  for (const name of ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'AGENT_EFFORT_VALUES']) {
    const node = ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).find(node => node.id.name === name)
    declarations.push('const ' + source.slice(node.start, node.end) + ';')
  }
  const parse = new Function('require', 'resolveCapabilityRoot', 'randomUUID', 'MAX_ACCOUNT_NAME_LENGTH',
    declarations.join('\n') + '\nreturn parseAgentStart;')(require, () => path.resolve('../engine'), () => 'fixture-session', 128)
  const request = { sessionId: 'new-session', resumeThreadId: 'old-thread', resumeSessionId: 'old-session',
    resumeTranscript: { computerId: COMPUTER_ID, nodeId: seatId } }
  assert.deepEqual(parse(request).resumeTranscript, request.resumeTranscript)
  for (const bad of [{ sessionId: 'new-session', resumeThreadId: 'old-thread', resumeTranscript: request.resumeTranscript },
    { ...request, resumeSessionId: undefined }, { ...request, resumeThreadId: undefined },
    ...[null, [], { computerId: COMPUTER_ID }, { computerId: COMPUTER_ID, nodeId: seatId, home: os.tmpdir() },
      { computerId: '', nodeId: seatId }, { computerId: COMPUTER_ID, nodeId: 'x'.repeat(129) }]
      .map(resumeTranscript => ({ ...request, resumeTranscript }))]) {
    assert.throws(() => parse(bad), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  }
})

test('a restored tab retained through page navigation binds with the current transcript client', async t => {
  const f = await machine(t)
  const before = f.fixture.graph.workspace.standalone.get(seatId)
  await f.fixture.remount()
  assert.equal(f.fixture.graph.workspace.standalone.get(seatId), before, 'navigation must retain the conversation and draft')
  const { record } = await sendSaved(f)
  assert.equal(f.starts.length, 1, 'exactly one backend start')
  assert.equal(f.launches.at(-1).kind, 'resume', 'backend resumed its saved provider thread')
  assert.equal(f.sends.length, 1, record.chatPanel.textContent)
  assert.equal(f.bindings.length, 1, 'actual capture confirms the same saved seat')
})

test('a departed view refuses binding through its unavailable transcript store by name', async t => {
  const f = await machine(t)
  const oldTranscript = f.fixture.graph.standaloneAgent.transcript
  await f.fixture.remount()
  assert.deepEqual(await oldTranscript.bind('unstarted-fixture-session', seatId),
    { ok: false, code: 'TRANSCRIPT_STORE_UNAVAILABLE' })
  assert.equal(f.bindings.length, 0, 'an unavailable client cannot claim capture custody')
})

test('navigation preserves the confirmed capture until a running tab explicitly releases it for placement', async t => {
  const f = await machine(t)
  const { record } = await sendSaved(f)
  const sessionId = record.session.snapshot().sessionId
  assert.ok(f.bindingFor(sessionId))
  await f.fixture.remount()
  assert.equal(f.fixture.graph.workspace.standalone.get(seatId), record)
  const released = await record.session.releaseTranscript(sessionId)
  assert.equal(released.ok, true)
  assert.equal(released.released, true, 'a retained running tab must release its real capture, rather than report nothing held')
  assert.equal(f.bindingFor(sessionId), null)
})

for (const [change, code] of [
  [{ resumeThreadId: 'another-thread' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  [{ resumeAccount: 'another-account' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  [{ resumeAccount: null }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  [{ agentId: 'another-agent' }, 'AGENT_RESUME_IDENTITY_MISMATCH'],
  [{ tier: 'claude-sonnet', resumeThreadProvider: 'claude' }, 'AGENT_RESUME_PROVIDER_MISMATCH'],
  [{ resumeSessionId: 'unknown-source' }, 'AGENT_RESUME_HOME_UNAVAILABLE'],
]) {
  test('restarted host refuses changed saved identity: ' + Object.keys(change).join(', '), async t => {
    const f = await machine(t, { restarted: true })
    assert.throws(() => f.host.startSession({ sessionId: 'refused-destination', tier: 'astra',
      resumeSessionId: f.original.sessionId, resumeThreadId: f.original.threadId, resumeThreadProvider: 'codex',
      resumeAccount: f.original.account, ...change }), { code })
    assert.equal(f.launches.length, 1, 'mismatched identity cannot reach either provider start or resume')
    assert.equal(f.sends.length, 0)
  })
}

for (const damage of ['missing', 'session substitution', 'malformed', 'oversized', 'symlink', 'relative home', 'foreign home']) {
  test('damaged original-home evidence refuses by name and keeps the reopened draft: ' + (damage === 'missing' ? 'missing and account unavailable' : damage), async t => {
    const f = await machine(t, { restarted: true, beforeReopen: ({ originDirectory, directory, registryFile }) => {
      const [name] = readdirSync(originDirectory)
      const file = path.join(originDirectory, name)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (damage === 'missing') { rmSync(file); writeFileSync(registryFile, '{"accounts":[]}') }
      else if (damage === 'malformed') writeFileSync(file, '{')
      else if (damage === 'oversized') writeFileSync(file, JSON.stringify({ ...record, padding: 'x'.repeat(16 * 1024) }))
      else if (damage === 'symlink') {
        const target = path.join(directory, 'synthetic-origin-target')
        writeFileSync(target, JSON.stringify(record))
        rmSync(file); symlinkSync(target, file)
      } else {
        if (damage === 'session substitution') record.sessionId = 'another-source'
        if (damage === 'relative home') record.home = 'relative-home'
        if (damage === 'foreign home') record.home = path.join(directory, 'foreign-profile-sentinel')
        writeFileSync(file, JSON.stringify(record))
      }
    } })
    const { record } = await sendSaved(f)
    assert.equal(f.launches.length, 1, 'unverified home cannot reach the provider')
    assert.equal(f.sends.length, 0)
    assert.equal(record.session.exportDraft().text, 'Recall my saved word.')
    assert.match(record.chatPanel.textContent, ['foreign home', 'missing'].includes(damage) ? /account|profile/i : /original sign-in home/)
    assert.doesNotMatch(record.chatPanel.textContent, /could not work out why|Open the agent page/)
  })
}

for (const answer of [
  { ok: false, code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' },
  { ok: false, error: { code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' } },
  { ok: false, code: 'UNFAMILIAR_BINDING_REASON' },
  { ok: false }, { ok: 1 },
]) {
  test('a real transcript-client refusal keeps the unsent restored draft: ' + JSON.stringify(answer), async t => {
    const f = await machine(t, { bindReceipt: answer })
    const { record } = await sendSaved(f)
    assert.equal(f.sends.length, 0)
    assert.equal(record.session.exportDraft().text, 'Recall my saved word.')
    assert.match(record.chatPanel.textContent, /conversation|record/i)
    assert.doesNotMatch(record.chatPanel.textContent, /could not work out why|Open the agent page/)
    assert.equal(record.session.snapshot().sessionId, null, 'the admitted but unbound session must be closed')
  })
}

test('transcript client preserves specific top-level and nested binding codes and names an absent code', async () => {
  let answer
  const client = createNodeTranscriptClient({ computerId: 'fixture-computer', bridge: {
    list: async () => ({ ok: true, records: [] }), bind: async () => answer,
  } })
  try {
    await client.ready
    for (answer of [{ ok: false, code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' },
      { ok: false, error: { code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' } }]) {
      await assert.rejects(client.bind('fixture-session', 'fixture-seat'), { code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' })
    }
    answer = { ok: false }
    await assert.rejects(client.bind('fixture-session', 'fixture-seat'), { code: 'TRANSCRIPT_BIND_UNCONFIRMED' })
  } finally { client.dispose() }
})

test('native origin write refuses a substituted directory and never follows its link', t => {
  const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'origin-directory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const destination = path.join(directory, 'destination'), linked = path.join(directory, 'linked')
  mkdirSync(destination); symlinkSync(destination, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const store = createNativeResumeOriginStore({ directory: linked })
  assert.throws(() => store.set('source', { threadId: 'thread', provider: 'codex', account: null,
    agentId: null, home: directory, databaseHome: null }), { code: 'AGENT_RESUME_ORIGIN_STORAGE_FAILED' })
  assert.deepEqual(readdirSync(destination), [])
})

test('native origin write refuses a substituted record link and preserves its target', t => {
  const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'origin-record-link-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const storeDirectory = path.join(directory, 'origins')
  const store = createNativeResumeOriginStore({ directory: storeDirectory })
  const origin = { threadId: 'thread', provider: 'codex', account: null, agentId: null, home: directory, databaseHome: null }
  store.set('source', origin)
  const [name] = readdirSync(storeDirectory)
  const record = path.join(storeDirectory, name), target = path.join(directory, 'synthetic-target')
  writeFileSync(target, 'Synthetic target retained.')
  rmSync(record); symlinkSync(target, record)
  assert.throws(() => store.set('source', origin), { code: 'AGENT_RESUME_ORIGIN_STORAGE_FAILED' })
  assert.equal(readFileSync(target, 'utf8'), 'Synthetic target retained.')
})

test('native origin read refuses a substituted directory even when its target has a valid record', t => {
  const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'origin-directory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const destination = path.join(directory, 'destination'), linked = path.join(directory, 'linked')
  const origin = { threadId: 'thread', provider: 'codex', account: null, agentId: null, home: directory, databaseHome: null }
  createNativeResumeOriginStore({ directory: destination }).set('source', origin)
  symlinkSync(destination, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => createNativeResumeOriginStore({ directory: linked }).get('source'), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
})

test('native origin writes fail closed for malformed identity, relative paths and oversized UTF-8 records', t => {
  const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'origin-write-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = createNativeResumeOriginStore({ directory: path.join(directory, 'origins') })
  const origin = { threadId: 'thread', provider: 'codex', account: null, agentId: null, home: directory, databaseHome: null }
  for (const invalid of [{ ...origin, provider: 'invented' }, { ...origin, home: 'relative' },
    { ...origin, threadId: '' }, { ...origin, home: path.resolve('猫'.repeat(4000)), databaseHome: path.resolve('猫'.repeat(4000)) }]) {
    assert.throws(() => store.set('source', invalid), { code: 'AGENT_RESUME_HOME_UNAVAILABLE' })
  }
  assert.equal(store.get('source'), null, 'no refused write can become resume evidence')
})

test('a failed native-origin flush leaves no record claiming that its home was saved', t => {
  const fs = require('node:fs')
  const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'origin-flush-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = createNativeResumeOriginStore({ directory })
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('Synthetic flush failure'), { code: 'EIO' }) })
  assert.throws(() => store.set('source', { threadId: 'thread', provider: 'codex', account: null,
    agentId: null, home: directory, databaseHome: null }), { code: 'AGENT_RESUME_ORIGIN_STORAGE_FAILED' })
  assert.equal(store.get('source'), null)
  assert.deepEqual(readdirSync(directory), [], 'failed atomic write must not leave a partial or temporary record')
})

test('native-origin save failure closes the admitted provider and preserves the restored draft before any send', async t => {
  const f = await machine(t, { restarted: true, beforeReopen: () => {
    t.mock.method(require('node:fs'), 'fsyncSync', () => { throw Object.assign(new Error('Synthetic flush failure'), { code: 'EIO' }) })
  } })
  const { record } = await sendSaved(f)
  assert.equal(f.sends.length, 0)
  assert.equal(record.session.exportDraft().text, 'Recall my saved word.')
  assert.deepEqual(f.nativeCloses, ['start', 'resume'], 'both old and unconfirmed resumed native sessions must be closed')
  assert.equal(f.host.activeSessionCount(), 0)
  assert.match(record.chatPanel.textContent, /could not save.*sign-in home/)
  assert.doesNotMatch(record.chatPanel.textContent, /could not work out why|Open the agent page/)
})

for (const surface of ['agent page', 'home screen']) for (const code of ['AGENT_SESSION_BINDING_UNCONFIRMED', 'AGENT_RESUME_ORIGIN_STORAGE_FAILED', 'AGENT_RESUME_IDENTITY_UNAVAILABLE', 'AGENT_RESUME_IDENTITY_MISMATCH', 'AGENT_RESUME_HOME_CHANGED', 'AGENT_AUTOMATIC_TURN_START_UNCONFIRMED']) {
  test(`${surface}: ${code} has a specific refusal sentence`, async t => {
    const dom = installDomStandIn()
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map([['mc.write.agent-session', 'enabled']])
    globalThis.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) }
    const root = dom.document.createElement('div'); dom.document.body.appendChild(root)
    const bridge = { availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'unrestricted' }),
      onEvent: () => () => {}, ownerContext: async () => owner, onOwnerContextChanged: () => () => {},
      start: async () => ({ ok: false, code }),
      close: async () => ({ closed: true }), interrupt: async () => ({ ok: true }), send: async () => { throw new Error('refusal cannot dispatch') } }
    const previousBridge = globalThis.mcAgent
    globalThis.mcAgent = bridge
    let release
    if (surface === 'agent page') release = mountAgentSessionSurface(root, { live: true, bridge, chatComposer: true })
    else release = mountChatTakeover(root, { live: true, choices: [{ id: 'agent:fixture', kind: 'agent', agentId: 'fixture', label: 'Agent 1' }], subjectId: 'agent:fixture' })
    t.after(() => {
      if (typeof release === 'function') release(); else release?.destroy?.()
      globalThis.mcAgent = previousBridge
      if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else delete globalThis.localStorage
      dom.restore()
    })
    await settle()
    const button = root.querySelector('[data-agent-action="start"]') || root.querySelector('[data-session-start]')
    if (button) { const form = root.querySelector('[data-session-form]'); form.elements.text.value = 'Keep my draft'; form.dispatch('submit', { preventDefault() {} }) }
    else {
      const input = root.querySelector('.chat-input textarea')
      assert.ok(input, root.textContent)
      input.value = 'Keep my draft'; input.dispatch('input')
      root.querySelector('.chat-send').click()
    }
    await settle()
    assert.match(root.textContent, code === 'AGENT_RESUME_HOME_CHANGED' ? /different sign-in folder/i
      : code === 'AGENT_AUTOMATIC_TURN_START_UNCONFIRMED' ? /did not confirm starting the continuation/i
      : code === 'AGENT_RESUME_ORIGIN_STORAGE_FAILED'
      ? /could not save.*sign-in home/i : code === 'AGENT_RESUME_IDENTITY_UNAVAILABLE'
        ? /no verified native session identity/ : code === 'AGENT_RESUME_IDENTITY_MISMATCH'
          ? /does not match its original agent or account/ : /could not confirm.*conversation|conversation.*could not be confirmed/i)
    assert.doesNotMatch(root.textContent, /could not work out why|Open the agent page/)
  })
}

for (const provider of ['codex', 'claude', 'gemini']) for (const state of ['default-before-registry', 'default-after-registry', 'named-after-registry']) {
  test(provider + ': published 1.0.48 standalone upgrade grid / ' + state, async t => {
    const named = state === 'named-after-registry'
    const f = await machine(t, { provider, named, restarted: true, published48: true, registryAtCreation: state !== 'default-before-registry' })
    const { record } = await sendSaved(f)
    assert.equal(f.sends.length, 1, record.chatPanel.textContent)
    const resumed = f.launches.find(row => row.kind === 'resume')
    assert.ok(resumed, JSON.stringify(f.refusals))
    assert.equal(resumed.request.threadId, f.original.threadId)
    assert.equal(provider === 'codex' ? resumed.request.env.CODEX_HOME : resumed.request.configDir || resumed.request.plan.configDir, f.originalHome)
    if (provider === 'gemini') assert.equal(resumed.request.plan.env.GEMINI_CLI_HOME, f.originalHome)
    assert.equal(record.session.snapshot().account, named ? 'original-account' : null)
    assert.equal(f.launches.filter(row => row.kind === 'start').length, 1)
    assert.match(record.chatPanel.textContent, /CHECKWORD/)
  })
}
for (const provider of ['codex', 'claude', 'gemini']) test(provider + ': published standalone account removal refuses by name and keeps the saved words and draft', async t => {
  const f = await machine(t, { provider, named: true, restarted: true, published48: true,
    legacyDamage: ({ registryFile }) => writeFileSync(registryFile, '{"accounts":[]}') })
  const { record, input } = await sendSaved(f)
  assert.equal(f.refusals.at(-1), 'AGENT_RESUME_ACCOUNT_UNAVAILABLE', record.chatPanel.textContent)
  assert.equal(f.sends.length, 0)
  assert.equal(f.launches.length, 1)
  assert.equal(input.value, 'Recall my saved word.')
  assert.match(record.chatPanel.textContent, /account that owns this saved conversation|account is no longer|conversation.*account/i)
})

for (const provider of ['codex', 'claude', 'gemini']) for (const published48 of [false, true]) {
  test(provider + ': ' + (published48 ? 'published 1.0.48' : 'cold 1.0.50') + ' standalone refuses a changed named-account sign-in folder', async t => {
    const f = await machine(t, { provider, named: true, restarted: true, published48,
      beforeReopen: ({ registryFile }) => {
        const record = JSON.parse(readFileSync(registryFile, 'utf8'))
        const field = provider === 'codex' ? 'profileDir' : provider === 'claude' ? 'configDir' : 'homeDir'
        const oldHome = record.accounts[0][field]
        record.accounts[0][field] = path.join(path.dirname(oldHome), 'later-home')
        writeFileSync(registryFile, JSON.stringify(record))
      },
      legacyDamage: published48 ? ({ legacyMetadata, originalHome }) => { legacyMetadata.pinnedHome = originalHome } : null,
    })
    const { record, input } = await sendSaved(f)
    assert.equal(f.launches.length, 1, 'neither old nor new sign-in folder starts the saved conversation')
    assert.equal(f.sends.length, 0)
    assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_CHANGED')
    assert.equal(input.value, 'Recall my saved word.')
    assert.match(record.chatPanel.textContent, /different sign-in folder/i)
    assert.match(record.chatPanel.textContent, /conversation is kept/i)
    assert.match(record.chatPanel.textContent, /choose the account again/i)
  })
}

test('Gemini: Stop after upgrade and the next send still resume the same recorded native conversation', async t => {
  const f = await machine(t, { provider: 'gemini', named: true, restarted: true, published48: true })
  const { record } = await sendSaved(f)
  assert.equal(f.sends.length, 1)
  const stop = record.chatPanel.querySelector('[data-session-stop]')
  assert.ok(stop && !stop.disabled)
  stop.click(); await settle()
  assert.equal(record.session.snapshot().sessionId, null)
  const chat = record.chatPanel.querySelector('[data-chat-panel]'), input = chat.querySelector('.chat-input textarea')
  input.value = 'Recall again.'; input.dispatch('input'); chat.querySelector('.chat-send').click()
  await settle()
  assert.equal(f.starts.length, 2)
  assert.equal(f.launches.filter(row => row.kind === 'start').length, 1)
  assert.equal(f.launches.filter(row => row.kind === 'resume').length, 2)
  assert.equal(f.sends.length, 2)
  assert.equal(f.sends[1].threadId, f.original.threadId)
})

for (const unverifiedAccountHome of [true, 'relative-folder']) test('cold named resume refuses an unverified configured home: ' + unverifiedAccountHome, async t => {
  const f = await machine(t, { restarted: true, unverifiedAccountHome })
  const { input } = await sendSaved(f)
  assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_UNAVAILABLE')
  assert.equal(f.launches.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(input.value, 'Recall my saved word.')
})
for (const provider of ['codex', 'claude', 'gemini']) test(provider + ': cold standalone with a removed named account keeps its words and refuses specifically', async t => {
  const f = await machine(t, { provider, restarted: true, beforeReopen: ({ registryFile }) => writeFileSync(registryFile, '{"accounts":[]}') })
  const { record, input } = await sendSaved(f)
  assert.equal(f.refusals.at(-1), 'AGENT_RESUME_ACCOUNT_UNAVAILABLE')
  assert.equal(f.launches.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(input.value, 'Recall my saved word.')
  assert.match(record.chatPanel.textContent, /CHECKWORD/)
  assert.doesNotMatch(record.chatPanel.textContent, /could not work out why/i)
})
test('a malformed recorded named home refuses as unverified, without claiming the registry changed', async t => {
  const f = await machine(t, { legacy: true, restarted: true, legacyDamage: ({ legacyMetadata }) => { legacyMetadata.pinnedHome = 'relative-folder' } })
  const { record } = await sendSaved(f)
  assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_UNAVAILABLE')
  assert.equal(f.launches.length, 1)
  assert.equal(f.sends.length, 0)
  assert.doesNotMatch(record.chatPanel.textContent, /now points to a different sign-in folder/i)
})
