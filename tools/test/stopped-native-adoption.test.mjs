import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { adoptStandaloneIntoTree } from '../../src/tree-standalone-adoption.js'
import { createFleetTreeStore, fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { installWorld, fleetFetch, mountView, settle as settleView } from './lib/tree-command-real-mount.mjs'
import { parseNativeStart } from './helpers/native-start-parser.mjs'
import { parseAst } from 'rollup/parseAst'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const require = createRequire(import.meta.url), fs = require('node:fs')
const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createStoppedConversationAdoption, REFUSAL } = require('../../shell/stopped-conversation-adoption.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const ENGINE = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const SOURCE = 'standalone-12345678-1234-4123-8123-123456789abc'
const NATIVE = 'saved-native-source', THREAD = 'saved-native-thread', COMPUTER = 'adoption-computer'
const owner = { version: 1, ownerId: 'fixture-owner', currentEpoch: 'fixture-epoch', kind: 'local' }
const principal = { kind: 'window', owner: {}, mayWrite: true, label: 'fixture' }
const authority = (agentId, provider) => ({ agentId, role: { id: 'worker', name: 'Worker', owns: 'Fixture task', mustNot: 'Fixture boundary', handoff: 'Fixture person' },
  agentAuthority: { agentId, provider, roleId: 'worker', expectedOrgRevision: 0, expectedRoleRevision: 0 } })

function commands(host, agentSessions = new Map(), recordTranscriptBinding = () => {}) {
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([key, kind]) =>
    [key, kind === 'function' ? () => ({}) : kind === 'object' ? {} : kind === 'number' ? 128 : 'fixture']))
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
  Object.assign(deps, { AGENT_EFFORT_VALUES: ['low', 'medium', 'high'], dialog: { showOpenDialog: async () => ({ canceled: true }) }, agentSessions, recordTranscriptBinding, currentAgentHost: () => host, getAgentHost: async () => host,
    agentIpcError: fail, rendererSafeAgentError: error => Object.assign(new Error(error.code), { code: error.code }),
    agentPayload(value, allowed) {
      if (!value || Object.keys(value).some(key => !allowed.includes(key))) fail('MC_AGENT_INVALID_PAYLOAD', 'invalid')
      return value
    },
    boundedAgentString(value, field, max) {
      if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f]/.test(value)) fail('MC_AGENT_INVALID_PAYLOAD', field)
      return value
    },
  })
  return createAgentCommandSurface(deps)
}

async function mounted(t, { provider = 'codex', named = true, damage = null, olderPages = false, liveReopen = false } = {}) {
  require('./fixtures/confined-engine/src/lib/agent-comms/tree-node-directory.js').reset()
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stopped-adoption-'))
  const originalHome = path.join(directory, 'original-home'), laterHome = path.join(directory, 'later-home')
  mkdirSync(originalHome); mkdirSync(laterHome)
  const origins = createNativeResumeOriginStore({ directory: path.join(directory, 'origins') })
  const account = named ? 'fixture-original-account' : null, tier = provider === 'claude' ? 'claude-sonnet' : 'astra'
  const identity = { nativeSessionId: NATIVE, threadId: THREAD, provider, account }
  const initialOrigin = { threadId: THREAD, provider, account, agentId: SOURCE, home: originalHome,
    databaseHome: provider === 'codex' ? originalHome : null }
  origins.set(NATIVE, initialOrigin)
  const source = { computerId: COMPUTER, nodeId: SOURCE }
  let transcriptStore = createNodeTranscriptStore({ directory: path.join(directory, 'transcripts') })
  const lines = [...(olderPages ? Array.from({ length: 150 }, (_, i) => ({ id: 'older-' + i, who: 'agent', text: 'Earlier reply ' + i, at: i })) : []),
    { id: 'person-old', who: 'you', text: 'Remember SAVED_MEMORY.', at: 1 },
    ...(liveReopen ? [
      { id: 'person-second', who: 'you', text: 'Second saved prompt.', at: 2 },
      { id: 'person-third', who: 'you', text: 'Third saved prompt.', at: 3 },
    ] : []),
    { id: 'context-old', who: 'you', text: 'Old ToolsEnabled context', promptSource: 'toolsenabled', at: 2 },
    { id: 'agent-old', who: 'agent', text: 'I will remember it.', at: 3 }]
  for (let offset = 0; offset < lines.length; offset += 100) {
    await transcriptStore.append({ ...source, entries: lines.slice(offset, offset + 100) })
  }
  await transcriptStore.bindSessionMetadata({ ...source, sessionId: NATIVE, replace: true,
    metadata: { threadId: THREAD, provider, account } })
  let tabs = { v: 1, tabs: [{ id: SOURCE, name: 'Restored agent', sessionId: NATIVE, tier }] }
  const launches = [], sends = [], sendRequests = [], starts = [], refusals = [], requests = [], nodes = [], hosts = [], releases = [], listeners = new Set(), closes = [], agentSessions = new Map()
  let capture = null, closeGate = null, resumeGate = null, closeRefusal = null, closeAfterExit = false, releaseRefusal = false, busyTurn = false, nativeTurn = 0, resumeCalls = 0
  let currentHost, failCopy = false, failIdentity = false, pauseCopy = null, configuredNamedHome = originalHome, parseTreeStart = false
  const engine = provider === 'claude' ? require('./fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js') : require(ENGINE)
  const native = (kind, request) => {
    launches.push({ kind, request })
    return { adapter: { sendTurn: async turn => {
      sends.push(turn)
      const turnId = 'recall-' + ++nativeTurn
      if (liveReopen && busyTurn) await request.onEvent({ type: 'turn_started', threadId: THREAD, turnId })
      if (liveReopen && !busyTurn) {
        setTimeout(async () => {
          await request.onEvent({ type: 'assistant_text_delta', text: 'SAVED_MEMORY', threadId: THREAD, turnId })
          await request.onEvent({ type: 'turn_completed', status: 'completed', threadId: THREAD, turnId })
        }, 5)
      }
      return { turnId }
    },
      interrupt: async () => {}, answerApproval() {} }, threadId: kind === 'resume' ? request.threadId : THREAD,
      ...(kind === 'resume' ? { resumed: { turns: [], turnCount: 0 } } : {}), close() {} }
  }
  t.mock.method(engine, provider === 'claude' ? 'startClaudeSession' : 'startCodexSession', async request => native('start', request))
  t.mock.method(engine, provider === 'claude' ? 'resumeClaudeSession' : 'resumeCodexSession', async request => { resumeCalls++; if (resumeGate) await resumeGate; return native('resume', request) })
  const planner = require('./fixtures/confined-engine/src/lib/agent-session-confinement.js')
  const beforeArgs = planner.codexConfigOverrideArgs
  planner.codexConfigOverrideArgs = require('../../../engine/src/lib/agent-session-confinement.js').codexConfigOverrideArgs
  const opener = () => {
    const copyStore = { read: request => transcriptStore.read(request),
      append: async request => { if (pauseCopy) await pauseCopy; if (failCopy) return { ok: false, durable: false }; return transcriptStore.append(request) },
      bindSessionMetadata: async request => { if (failIdentity) return { ok: false, durable: false }; return transcriptStore.bindSessionMetadata(request) } }
    const host = createAgentHost({ enginePath: ENGINE, defaultCwd: directory,
      profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(directory).root,
      resumeOriginDirectory: path.join(directory, 'origins'), freeMemory: () => 64 * 1024 ** 3,
      sessionAuthority: { bind: () => ({ bound: true, credential: require('node:crypto').randomBytes(32).toString('base64url') }), revoke() {}, assert: () => ({ valid: true }) },
      accountResolver: async request => named ? { rotated: true, account: { name: request.preferred || account, provider, resolvedHome: configuredNamedHome } }
        : { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' },
      confinementPlanner: ({ account: selected } = {}) => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, account: selected?.name || null,
        ...(provider === 'claude' ? { configDir: named ? laterHome : originalHome } : { env: { CODEX_HOME: laterHome },
          codexConfig: { sqlite_home: laterHome }, codexArgs: planner.codexConfigOverrideArgs({ sqlite_home: laterHome }) }) }),
      stoppedConversationAdoption: createStoppedConversationAdoption({
        readTabs: () => JSON.stringify(tabs), readTranscript: request => transcriptStore.read(request), store: copyStore }),
    })
    if (liveReopen) {
      capture = createNodeTranscriptCapture({ store: transcriptStore, sessionMetadata: id => host.sessionTranscriptMetadata(id) })
      host.onAcceptedPrompt(request => capture.recordAcceptedTranscriptSend(request))
    }
    host.onEvent(async packet => { if (capture) await capture.packet(packet); for (const fn of listeners) fn(packet) })
    currentHost = host; hosts.push(host)
    return host
  }
  opener()
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const world = liveReopen ? await installWorld(fleetFetch({ computerId: COMPUTER }), { asyncFrames: true }) : null
  const { document, restore } = world ? { document: globalThis.document, restore: () => world.restore() } : installDomStandIn()
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = world?.storage || { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  globalThis.localStorage.setItem('mc.write.agent-session', 'enabled')
  const root = document.createElement('div'); document.body.appendChild(root)
  const bridge = { availability: async () => ({ ok: true }), ownerContext: async () => owner, onOwnerContextChanged: () => () => {},
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    adoptTreeAddress: async request => { requests.push(request)
      try { return await commands(currentHost, agentSessions, request => capture?.bind({ ...request, computerId: COMPUTER, authoritative: true })).run('agent:tree-adopt', request, principal) }
      catch (error) { refusals.push(error.code); throw error } },
    start: async request => { starts.push(request)
      try { const parsed = parseTreeStart ? parseNativeStart(request) : request
        const result = await currentHost.startSession({ ...parsed, ...authority(request.roleBinding?.agentId || SOURCE, provider) })
        agentSessions.set(result.sessionId, { owner: principal.owner }); return result }
      catch (error) { refusals.push(error.code); throw error }
    },
    send: request => { sendRequests.push(request); return currentHost.sendTurn(request) },
    close: async request => { closes.push(request); if (closeGate) await closeGate
      if (closeRefusal) {
        if (closeAfterExit) {
          await currentHost.closeSession(request); agentSessions.delete(request.sessionId)
          const packet = { sessionId: request.sessionId, event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } } }
          await capture?.packet(packet); for (const fn of listeners) fn(packet)
          await settle()
        }
        return closeRefusal
      }
      const receipt = await currentHost.closeSession(request); agentSessions.delete(request.sessionId); return receipt },
    interrupt: request => currentHost.interrupt(request) }
  const transcriptBridge = {
    read: request => transcriptStore.read(request), append: request => transcriptStore.append(request),
    list: request => transcriptStore.list(request), onError: () => () => {},
    ...(liveReopen ? { bind: request => capture.bind({ ...request, authoritative: true }),
      release: async request => releaseRefusal ? { ok: false, code: 'FIXTURE_FLUSH_REFUSED' } : capture.release(request) } : {}),
  }
  const transcripts = createNodeTranscriptClient({ computerId: COMPUTER, bridge: transcriptBridge })
  const panel = mountStandaloneAgent(root, { id: SOURCE, computerId: COMPUTER, live: true, bridge,
    start: { tier }, restored: { ...identity, sessionId: NATIVE, lines: olderPages ? lines.slice(-3) : lines, cause: 'restart' },
    transcript: transcripts, onSessionOpened: ({ sessionId }) => { tabs.tabs[0].sessionId = sessionId }, onPlaced: nodeId => { nodes.push(nodeId); tabs = { v: 1, tabs: [] } } })
  let saved = null
  const store = createFleetTreeStore({ computerId: COMPUTER, storage: {
    read: () => saved, write: (_key, value) => { saved = structuredClone(value)
      if (world) world.storage.setItem(fleetTreesStorageKey(COMPUTER), JSON.stringify(value)); return true } } })
  const args = { store, session: panel, bridge,
    identityFor: node => ({ selfName: 'Worker', treeKey: node.id, requestKeys: { treeAnchors: [node.id], threadId: node.id } }),
    async bindSession(node, receipt, initial) {
      if (liveReopen && receipt?.stopped !== true) {
        await transcripts.save(node.id, { lines: initial.transcript, threadId: initial.threadId, provider, account })
        await transcripts.bind(initial.sessionId, node.id)
      }
      await transcripts.readLatest(node.id)
      return { getStartOptions: () => ({ tier, roleBinding: { agentId: node.id } }), onSessionChange() {} }
    } }
  t.after(async () => {
    for (const release of releases) release()
    panel.dispose(); for (const host of hosts) await host.closeAll()
    if (capture) await capture.shutdown()
    await transcriptStore.shutdown(); restore()
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage
    planner.codexConfigOverrideArgs = beforeArgs
    rmSync(directory, { recursive: true, force: true })
  })
  await settle()
  const input = root.querySelector('.chat-input textarea'); input.value = 'Unsent kept draft.'; input.dispatch('input')
  if (damage === 'ownership') origins.set(NATIVE, { ...initialOrigin, agentId: 'another-agent' })
  if (damage === 'account') origins.set(NATIVE, { ...initialOrigin, account: 'another-account' })
  if (damage === 'missing-origin') rmSync(path.join(directory, 'origins'), { recursive: true, force: true })
  if (damage === 'tab') tabs.tabs[0].sessionId = 'another-native-source'
  if (damage === 'canonical') await transcriptStore.bindSessionMetadata({ ...source, sessionId: NATIVE, replace: true,
    metadata: { threadId: 'different-thread', provider, account } })
  if (damage === 'copy') failCopy = true
  if (damage === 'identity-save') failIdentity = true
  if (damage === 'origin-save') t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('synthetic origin flush failure'), { code: 'EIO' }) })
  if (damage === 'active') await currentHost.startSession({ sessionId: NATIVE, tier, ...authority(SOURCE, provider) })
  return { panel, store, args, input, root, requests, launches, sends, sendRequests, starts, refusals, originalHome, origins, identity, initialOrigin, closes,
    pauseClose() { let release; closeGate = new Promise(resolve => { release = resolve }); return () => { closeGate = null; release() } },
    pauseResume() { let release; resumeGate = new Promise(resolve => { release = resolve }); return () => { resumeGate = null; release() } },
    refuseClose(value, afterExit = false) { closeRefusal = value; closeAfterExit = afterExit }, refuseRelease() { releaseRefusal = true }, allowRelease() { releaseRefusal = false }, setBusy() { busyTurn = true }, get resumeCalls() { return resumeCalls },
    async answer(text) { input.value = text; input.dispatch('input'); root.querySelector('.chat-send').click(); await settleView(25); await capture.flushNode(source)
      const expectedPhase = busyTurn ? 'working' : 'open'
      for (let i = 0; i < 200 && panel.snapshot().phase !== expectedPhase; i++) await settleView(1)
      assert.equal(panel.snapshot().phase, expectedPhase, root.textContent) },
    async mountCircle(nodeId) {
      parseTreeStart = true
      Object.assign(world.bridge, bridge, { confinement: async () => ({ ok: true, tier: 'standard', isolated: true, recorded: true }), profiles: async () => ({ ok: true, profiles: [] }) })
      world.storage.setItem('mc.set.tree_style', 'boxes')
      window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: [directory] }) }
      window.mcProviders = { presence: async () => ({ codex: { installed: true } }) }
      const oldOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
      globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org: { revision: 1,
        agents: [{ id: nodeId, role: 'worker', provider, enabled: true }], edges: [] },
        roles: [{ id: 'worker', name: 'Worker', revision: 1, capabilities: {} }] }) }
      window.mcTranscripts = transcriptBridge
      const view = await mountView(world, { computerId: COMPUTER })
      releases.push(() => { view.destroy(); view.el.remove(); if (oldOrg) Object.defineProperty(globalThis, 'mcOrg', oldOrg); else delete globalThis.mcOrg })
      const open = async () => { view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('keydown', { key: 'Enter', shiftKey: true }); await settleView(8); return view.el.querySelector('[data-rail-chat-host] .chat') }
      return { view, open, row: () => JSON.parse(world.storage.getItem(fleetTreesStorageKey(COMPUTER))).nodes.find(node => node.id === nodeId) }
    },
    changeNamedHome() { configuredNamedHome = laterHome },
    source, nodes, transcripts, releaseAfter: fn => releases.push(fn), get host() { return currentHost }, get nativeStore() { return transcriptStore },
    pauseCopy() { let release; pauseCopy = new Promise(resolve => { release = resolve }); return () => { pauseCopy = null; release() } },
    async reopen() { await currentHost.closeAll(); await transcriptStore.shutdown()
      transcriptStore = createNodeTranscriptStore({ directory: path.join(directory, 'transcripts') }); opener() },
    read: nodeId => transcriptStore.read({ computerId: COMPUTER, nodeId, limit: 100 }),
  }
}

for (const provider of ['codex', 'claude']) for (const named of [false, true]) {
  test(provider + ': stopped placement survives another full host quit with its exact native identity and original ' + (named ? 'named' : 'default') + ' home', async t => {
    const f = await mounted(t, { provider, named })
    const result = await adoptStandaloneIntoTree(f.args)
    assert.equal(result.ok, true, result.sentence)
    const saved = await f.read(result.nodeId)
    assert.equal(saved.metadata?.nativeSessionId, NATIVE, 'placement copied lines but lost the native selector')
    assert.equal(saved.metadata.threadId, THREAD)
    assert.equal(saved.metadata.provider, provider)
    assert.equal(saved.metadata.account, f.identity.account)
    assert.deepEqual(saved.entries.map(row => row.text), ['Remember SAVED_MEMORY.', 'I will remember it.'])
    assert.deepEqual(f.origins.get(NATIVE), { ...f.initialOrigin, agentId: result.nodeId },
      'the durable source selector must change only its declared owner, preserving every native/home field')
    assert.equal(f.input.value, 'Unsent kept draft.')
    assert.equal(f.store.getNode(result.nodeId).message, '', 'placement must not resubmit an old prompt')
    assert.equal(f.launches.length, 0)
    await f.reopen()
    const circleRoot = document.createElement('div'); document.body.appendChild(circleRoot)
    let control
    const release = mountAgentSessionSurface(circleRoot, { live: true, bridge: f.args.bridge, chatComposer: true,
      onController: value => { control = value },
      resumeConversation: { sessionId: saved.metadata.nativeSessionId, threadId: saved.metadata.threadId,
        provider: saved.metadata.provider, account: saved.metadata.account,
        transcript: { computerId: COMPUTER, nodeId: result.nodeId } },
      getStartOptions: () => ({ tier: provider === 'claude' ? 'claude-sonnet' : 'astra', roleBinding: { agentId: result.nodeId } }) })
    f.releaseAfter(release); await settle()
    assert.equal((await control.send('Recall SAVED_MEMORY.')).ok, true)
    assert.equal(f.launches.length, 1)
    assert.equal(f.launches[0].kind, 'resume', 'a fresh provider conversation was silently started')
    const launch = f.launches[0].request
    assert.equal(launch.threadId, THREAD)
    assert.equal(provider === 'claude' ? launch.configDir || launch.plan.configDir : launch.env.CODEX_HOME, f.originalHome)
    if (provider === 'codex') assert.equal(launch.plan.codexConfig.sqlite_home, f.originalHome)
    assert.equal(f.sends[0].threadId, THREAD)
    await assert.rejects(async () => f.host.startSession({ sessionId: 'old-tab-claim', tier: provider === 'claude' ? 'claude-sonnet' : 'astra',
      resumeSessionId: NATIVE, resumeThreadId: THREAD, resumeThreadProvider: provider, resumeAccount: f.identity.account,
      ...authority(SOURCE, provider) }), { code: 'AGENT_RESUME_IDENTITY_MISMATCH' })
  })
}

for (const provider of ['codex', 'claude']) for (const cold of [false, true]) {
  test(provider + ': adopted circle ' + (cold ? 'after full quit' : 'in the placed tab') + ' refuses a changed named home without rewriting its transferred origin', async t => {
    const f = await mounted(t, { provider, named: true })
    const placed = await adoptStandaloneIntoTree(f.args)
    assert.equal(placed.ok, true, placed.sentence)
    const transferred = f.origins.get(NATIVE)
    assert.deepEqual(transferred, { ...f.initialOrigin, agentId: placed.nodeId })
    f.changeNamedHome()
    if (cold) {
      const saved = await f.read(placed.nodeId)
      await f.reopen()
      const circleRoot = document.createElement('div'); document.body.appendChild(circleRoot)
      let control
      const release = mountAgentSessionSurface(circleRoot, { live: true, bridge: f.args.bridge, chatComposer: true,
        onController: value => { control = value },
        resumeConversation: { sessionId: saved.metadata.nativeSessionId, threadId: saved.metadata.threadId,
          provider: saved.metadata.provider, account: saved.metadata.account,
          transcript: { computerId: COMPUTER, nodeId: placed.nodeId } },
        getStartOptions: () => ({ tier: provider === 'claude' ? 'claude-sonnet' : 'astra', roleBinding: { agentId: placed.nodeId } }) })
      f.releaseAfter(release); await settle()
      assert.equal((await control.send('Kept changed-home recall.')).ok, false)
      assert.match(circleRoot.textContent, /different sign-in folder/i)
    } else {
      f.input.value = 'Kept changed-home recall.'; f.input.dispatch('input')
      f.root.querySelector('.chat-send').click(); await settle()
      assert.match(f.root.textContent, /different sign-in folder/i)
    }
    assert.equal(f.refusals.at(-1), 'AGENT_RESUME_HOME_CHANGED')
    assert.equal(f.launches.length, 0, 'changed named home dispatched a native resume or fresh conversation')
    assert.equal(f.sends.length, 0)
    assert.deepEqual(f.origins.get(NATIVE), transferred)
    assert.equal(f.store.getNode(placed.nodeId).id, placed.nodeId)
  })
}

test('stopped transfer copies older canonical pages beyond the restored tab’s visible lines', async t => {
  const f = await mounted(t, { olderPages: true })
  const result = await adoptStandaloneIntoTree(f.args)
  assert.equal(result.ok, true, result.sentence)
  const entries = []
  let before
  do {
    const page = await f.nativeStore.read({ computerId: COMPUTER, nodeId: result.nodeId, limit: 100,
      ...(before ? { before, strictBefore: true } : {}) })
    assert.equal(page.ok, true)
    entries.unshift(...page.entries)
    before = page.before
  } while (before)
  assert.deepEqual(entries.map(entry => entry.id),
    [...Array.from({ length: 150 }, (_, i) => 'older-' + i), 'person-old', 'agent-old'])
  assert.equal(f.launches.length, 0)
})

test('the still-mounted placed tab resumes as its circle using the circle canonical record', async t => {
  const f = await mounted(t)
  const result = await adoptStandaloneIntoTree(f.args)
  assert.equal(result.ok, true)
  assert.equal(f.panel.restoredNativeConversation(), null, 'the old tab must have no independent adoption claim')
  f.input.value = 'Recall in the placed tab.'; f.input.dispatch('input')
  f.root.querySelector('.chat-send').click(); await settle()
  assert.equal(f.sends.length, 1, f.root.textContent)
  assert.equal(f.starts[0].resumeSessionId, NATIVE)
  assert.equal(f.starts[0].resumeThreadId, THREAD)
  assert.deepEqual(f.starts[0].resumeTranscript, { computerId: COMPUTER, nodeId: result.nodeId })
  assert.equal(f.starts[0].roleBinding.agentId, result.nodeId)
})

for (const damage of ['ownership', 'account', 'missing-origin', 'tab', 'canonical', 'copy', 'identity-save', 'origin-save', 'active']) {
  test('stopped placement refuses ' + damage + ' by name and preserves the original mounted tab and draft', async t => {
    const f = await mounted(t, { damage })
    const before = f.panel.snapshot(), original = await f.read(SOURCE)
    const oldOrigin = damage === 'missing-origin' ? null : f.origins.get(NATIVE)
    const result = await adoptStandaloneIntoTree(f.args)
    assert.equal(result.ok, false, 'unverified placement was reported as successful')
    assert.equal(result.sentence, REFUSAL)
    assert.deepEqual(f.panel.snapshot(), before)
    assert.deepEqual(await f.read(SOURCE), original)
    assert.deepEqual(f.origins.get(NATIVE), oldOrigin, 'a refused placement must leave original native ownership intact')
    assert.equal(f.store.snapshot().nodes.length, 0)
    assert.equal(f.input.value, 'Unsent kept draft.')
    assert.equal(f.nodes.length, 0)
    assert.equal(f.panel.beginPlacement().ok, true, 'refusal permits retry in the original tab')
    f.panel.cancelPlacement()
    assert.equal(f.launches.length, damage === 'active' ? 1 : 0)
  })
}

test('stopped placement waits for durable persistence and a duplicate transfer cannot steal native ownership', async t => {
  const f = await mounted(t), release = f.pauseCopy()
  const pending = adoptStandaloneIntoTree(f.args)
  await settle()
  assert.equal(f.nodes.length, 0)
  assert.equal(f.origins.get(NATIVE).agentId, SOURCE)
  assert.equal((await adoptStandaloneIntoTree(f.args)).ok, false)
  release()
  const result = await pending
  assert.equal(result.ok, true)
  const request = f.requests[0]
  await assert.rejects(f.host.adoptStoppedConversation({ ...request, requestKeys: { treeAnchors: ['second'], threadId: 'second' }, treeKey: 'second' }),
    { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.equal(f.origins.get(NATIVE).agentId, result.nodeId)
})

test('a source resumed while copying refuses placement and keeps the original native owner', async t => {
  const f = await mounted(t), release = f.pauseCopy()
  const before = f.panel.snapshot()
  const placing = adoptStandaloneIntoTree(f.args); await settle()
  await f.host.startSession({ sessionId: 'parallel-original', tier: 'astra', resumeSessionId: NATIVE,
    resumeThreadId: THREAD, resumeThreadProvider: 'codex', resumeAccount: f.identity.account,
    ...authority(SOURCE, 'codex') })
  assert.equal(f.launches.length, 1, 'the competing source must really pass strict native resume admission')
  assert.equal(f.launches[0].kind, 'resume')
  assert.equal(f.launches[0].request.threadId, THREAD)
  release()
  const result = await placing
  assert.equal(result.ok, false)
  assert.equal(result.sentence, REFUSAL)
  assert.deepEqual(f.origins.get(NATIVE), f.initialOrigin)
  assert.deepEqual(f.panel.snapshot(), before)
  assert.equal(f.sends.length, 0)
  assert.equal(f.nodes.length, 0)
  assert.equal(f.store.snapshot().nodes.length, 0)
})

test('a restored tab without native identity or a mismatched host receipt refuses placement', async t => {
  const f = await mounted(t)
  const getter = f.panel.restoredNativeConversation
  for (const native of [null, { ...getter(), nativeSessionId: null }, { ...getter(), threadId: null }]) {
    f.panel.restoredNativeConversation = () => native
    const result = await adoptStandaloneIntoTree(f.args)
    assert.equal(result.ok, false)
    assert.equal(result.sentence, REFUSAL)
    assert.equal(f.nodes.length, 0)
  }
  f.panel.restoredNativeConversation = getter
  f.args.bridge.adoptTreeAddress = async () => ({ ok: true, stopped: true, ...getter(), nodeId: 'wrong-node', treeKey: 'wrong-tree' })
  assert.equal((await adoptStandaloneIntoTree(f.args)).ok, false)
  assert.equal(f.origins.get(NATIVE).agentId, SOURCE)
  assert.equal(f.input.value, 'Unsent kept draft.')
})

test('stopped adoption from a relay principal refuses before touching saved native identity', async t => {
  const f = await mounted(t)
  const nativeConversation = { ...f.identity, sourceTranscript: f.source }
  await assert.rejects(commands(f.host).run('agent:tree-adopt', { nativeConversation, selfName: 'Worker', treeKey: 'target',
    requestKeys: { treeAnchors: ['target'], threadId: 'target' } }, { ...principal, kind: 'relay' }),
    { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.deepEqual(f.origins.get(NATIVE), f.initialOrigin)
})


test('an idle reopened live tab settles before placement and carries all six person prompts', async t => {
  const f = await mounted(t, { named: false, liveReopen: true })
  for (const text of ['Fourth live prompt.', 'Fifth live prompt.', 'Sixth live prompt.']) await f.answer(text)
  const sourceId = f.panel.snapshot().sessionId
  const origin = f.origins.get(sourceId)
  assert.equal(f.panel.snapshot().phase, 'open')
  const result = await adoptStandaloneIntoTree(f.args)
  assert.equal(result.ok, true, result.sentence + ' ' + f.refusals.join(','))
  const saved = await f.read(result.nodeId)
  assert.deepEqual(saved.entries.filter(row => row.who === 'you').map(row => row.text),
    ['Remember SAVED_MEMORY.', 'Second saved prompt.', 'Third saved prompt.',
      'Fourth live prompt.', 'Fifth live prompt.', 'Sixth live prompt.'])
  assert.equal(saved.metadata.nativeSessionId, sourceId)
  assert.deepEqual(f.origins.get(sourceId), { ...origin, agentId: result.nodeId })
  assert.equal(f.closes.length, 1, 'placement left the standalone native session open')
  assert.equal(f.panel.snapshot().sessionId, null)
  assert.equal(f.host.sessionActivity(sourceId), null)
  await f.reopen()
  const circle = await f.mountCircle(result.nodeId), chat = await circle.open()
  for (const text of ['Remember SAVED_MEMORY.', 'Second saved prompt.', 'Third saved prompt.',
    'Fourth live prompt.', 'Fifth live prompt.', 'Sixth live prompt.']) {
    assert.ok(chat.textContent.includes(text), 'quit and reopen lost a carried person prompt: ' + text)
  }
})

test('live restored placement waits for native cleanup before any ownership transfer', async t => {
  const f = await mounted(t, { liveReopen: true })
  await f.answer('Answered after reopening.')
  const sourceId = f.panel.snapshot().sessionId, origin = f.origins.get(sourceId)
  const release = f.pauseClose(); t.after(release)
  const pending = adoptStandaloneIntoTree(f.args); await settle()
  assert.equal(f.closes.length, 1)
  assert.equal(f.requests.length, 0, 'placement crossed the host transfer before cleanup settled')
  assert.equal(f.nodes.length, 0)
  assert.deepEqual(f.origins.get(sourceId), origin)
  release()
  const placed = await pending
  assert.equal(placed.ok, true, placed.sentence + ' ' + f.refusals.join(','))
})

for (const failure of ['close-refused', 'close-unconfirmed', 'close-false', 'close-error', 'close-after-exit', 'flush-refused', 'busy']) {
  test('live restored placement refuses ' + failure + ' without transferring native ownership', async t => {
    const f = await mounted(t, { liveReopen: true })
    if (failure === 'busy') { await f.answer('The first reopened turn finished.'); f.setBusy() }
    await f.answer('Answered after reopening.')
    const before = f.panel.snapshot(), sourceId = before.sessionId, origin = f.origins.get(sourceId)
    if (failure === 'close-refused') f.refuseClose({ ok: false, closed: false, sessionId: sourceId })
    if (failure === 'close-unconfirmed') f.refuseClose({ ok: true, closed: true, sessionId: 'another-session' })
    if (failure === 'close-false') f.refuseClose({ ok: true, closed: false, sessionId: sourceId })
    if (failure === 'close-error') f.refuseClose({ ok: false, closed: true, sessionId: sourceId })
    if (failure === 'close-after-exit') f.refuseClose({ ok: false, closed: false, sessionId: sourceId }, true)
    if (failure === 'flush-refused') t.mock.method(f.transcripts, 'release', async () => ({ ok: false, code: 'FIXTURE_FLUSH_REFUSED' }))
    const result = await adoptStandaloneIntoTree(f.args)
    if (failure === 'busy') assert.equal(f.closes.length, 0, 'a working native turn must be refused before close')
    assert.equal(result.ok, false, 'placement claimed a live or unsettled native source')
    assert.match(result.sentence, /finish|stopp|sav|flush|clos/i)
    assert.equal(f.requests.length, 0)
    assert.equal(f.nodes.length, 0)
    assert.equal(f.store.snapshot().nodes.length, 0)
    assert.deepEqual(f.origins.get(sourceId), origin)
    if (!['flush-refused', 'close-after-exit'].includes(failure)) assert.equal(f.panel.snapshot().sessionId, sourceId)
    if (failure === 'close-after-exit') assert.equal(f.panel.snapshot().sessionId, null, 'the terminal event must really precede the refused close receipt')
  })
}

test('Send during an adopted circle native Resume waits and reaches that thread exactly once', async t => {
  const f = await mounted(t, { named: false, liveReopen: true })
  await f.answer('Answered after reopening.')
  const result = await adoptStandaloneIntoTree(f.args)
  assert.equal(result.ok, true, result.sentence)
  assert.equal(f.store.getNode(result.nodeId).sessionId, f.starts[0].sessionId, 'the stopped circle must keep its historical native address for Resume and queued words')
  const circle = await f.mountCircle(result.nodeId)
  const release = f.pauseResume(); t.after(release)
  const chat = await circle.open()
  chat.openActions()
  const resume = chat.querySelectorAll('.chat-actions-list button').find(row => row.textContent.startsWith('Resume with a fresh agent'))
  assert.ok(resume, chat.textContent)
  resume.dispatch('click'); await settleView(15)
  const starts = f.starts.length, before = f.sends.length, sendRequests = f.sendRequests.length
  assert.equal(starts, 2, 'circle did not enter native Resume')
  assert.equal(f.resumeCalls, 2, 'the real IPC parser refused the default native Resume before dispatch')
  assert.equal(f.starts.at(-1).resumeThreadId, THREAD, 'circle lost its own native thread')
  const currentChat = await circle.open(), input = currentChat.querySelector('.chat-input textarea')
  input.value = 'Recall once during Resume.'; input.dispatch('input'); currentChat.querySelector('.chat-send').click()
  await settleView(15)
  assert.equal(f.sendRequests.length, sendRequests, 'early Send crossed the bridge before Resume finished')
  assert.equal(f.sends.length, before, 'early Send reached a source session during Resume')
  assert.equal(f.starts.length, starts, 'early Send started another replacement')
  assert.doesNotMatch(currentChat.textContent, /did not finish closing|fresh one started/i)
  release(); await settleView(35)
  assert.equal(f.starts.length, starts)
  assert.equal(f.sends.length, before + 1, 'queued recall did not drain after the native Resume settled')
  assert.equal(f.sends.at(-1).threadId, THREAD)
  assert.equal(f.sendRequests.at(-1).text, 'Recall once during Resume.')
  assert.ok(f.sends.at(-1).text.startsWith('Recall once during Resume.'), 'native send lost the person words before adding current context')
  assert.equal(f.launches.filter(row => row.kind === 'start').length, 0)
})


test('placement settlement requires the tab placement lock', async t => {
  const f = await mounted(t)
  const result = await f.panel.settlePlacement()
  assert.equal(result.ok, false)
  assert.equal(f.closes.length, 0)
  assert.equal(f.requests.length, 0)
})

test('session settlement requires the controller placement lock', async t => {
  const f = await mounted(t)
  const root = document.createElement('div'); document.body.appendChild(root)
  let control
  const release = mountAgentSessionSurface(root, { live: true, bridge: f.args.bridge,
    onController: value => { control = value } })
  f.releaseAfter(release); await settle()
  assert.equal((await control.settlePlacement()).ok, false)
  assert.equal(f.closes.length, 0)
})

test('live placement refuses unconfirmed transcript capture before closing the source', async t => {
  const f = await mounted(t, { liveReopen: true })
  await f.answer('Answered after reopening.')
  const sourceId = f.panel.snapshot().sessionId
  f.panel.setTranscript({})
  const result = await adoptStandaloneIntoTree(f.args)
  assert.equal(result.ok, false)
  assert.equal(f.panel.snapshot().sessionId, sourceId)
  assert.equal(f.closes.length, 0)
  assert.equal(f.requests.length, 0)
})

test('a refused capture flush can retry placement after confirmed source closure', async t => {
  const f = await mounted(t, { liveReopen: true })
  await f.answer('Answered after reopening.')
  const sourceId = f.panel.snapshot().sessionId
  f.refuseRelease()
  assert.equal((await adoptStandaloneIntoTree(f.args)).ok, false)
  assert.equal(f.panel.snapshot().sessionId, null)
  assert.equal(f.requests.length, 0)
  f.allowRelease()
  const result = await adoptStandaloneIntoTree(f.args)
  assert.equal(result.ok, true, result.sentence)
  assert.equal(f.closes.length, 1)
  assert.equal(f.requests[0].nativeConversation.nativeSessionId, sourceId)
  const saved = await f.read(result.nodeId)
  assert.equal(saved.metadata.nativeSessionId, sourceId)
  assert.deepEqual(saved.entries.filter(row => row.who === 'you').map(row => row.text),
    ['Remember SAVED_MEMORY.', 'Second saved prompt.', 'Third saved prompt.', 'Answered after reopening.'])
})

// Call the actual renderer route with values for cases the composer normally
// fences earlier, so the queue itself cannot silently discard attachments.
function pendingResumeRoute({ enqueue }) {
  const source = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const view = parseAst(source).body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'computersView').declaration
  const route = view.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'treeCardSend')
  return new Function('treeStore', 'notePersonSpokeTo', 'parseSlashCommand', 'nodeReplacementFlight', 'outboxEnqueue', 'QUEUE_PANEL',
    source.slice(route.start, route.end) + '\nreturn treeCardSend')({}, () => {}, () => null, { busy: () => true }, enqueue, { busyAttachment: 'Keep these attachments in the draft until Resume finishes.' })
}

test('the pending Resume queue refuses attachments and returns the complete draft', () => {
  const failures = [], queued = []
  const route = pendingResumeRoute({ enqueue: (...args) => { queued.push(args); return { ok: true } } })
  route({ id: 'circle', sessionId: 'old-native' }, 'words with attachment', {
    attachments: [{ path: 'fixture-picture.png' }], fail: (...args) => failures.push(args), reply() {} })
  assert.equal(queued.length, 0)
  assert.equal(failures.length, 1)
  assert.match(failures[0][0], /attachments/)
  assert.deepEqual(failures[0][1], { restoreDraft: true })
})

test('a refused pending Resume queue returns the unsent draft instead of accepting it', () => {
  const failures = [], accepted = []
  const route = pendingResumeRoute({ enqueue: () => ({ ok: false, sentence: 'This queue cannot save your words.' }) })
  route({ id: 'circle', sessionId: 'old-native' }, 'unsent words', {
    fail: (...args) => failures.push(args), accepted: () => accepted.push(true), reply() {} })
  assert.equal(accepted.length, 0)
  assert.deepEqual(failures, [['This queue cannot save your words.', { restoreDraft: true }]])
})
