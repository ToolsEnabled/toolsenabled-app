/* THE SHARED AGENT COMMAND SURFACE -- the one module every mc-agent:* and
 * mc-org:* body lives in, so the Electron IPC handlers and the relay facade
 * docs/relay-agent-facade-DESIGN.md names cannot drift apart.
 *
 * WHAT THIS PROVES, per command, against FAKE dependencies (the module never
 * imports electron, which is the whole reason it can be exercised here):
 *
 *   1. INVENTORY, fail-closed. The thirty channel names are read out of
 *      shell/main.cjs's ipcMain.handle() registrations, never typed here, and
 *      every one must be a command the surface knows -- and every surface
 *      command must be a channel main.cjs registers and forwards to it by
 *      name. A handler added to one side and not the other fails the suite;
 *      it never skips.
 *   2. THE WINDOW PRINCIPAL BEHAVES AS THE HANDLERS DID: same dependency
 *      called with the same shaped arguments, same refusal codes, same order
 *      of checks -- including MC_AGENT_UNKNOWN_SESSION when the session
 *      belongs to another owner, and the image fence at send.
 *   3. mayWrite:false REFUSES EVERY WRITE with MC_AGENT_PRINCIPAL_READ_ONLY
 *      before any dependency is touched, and every read still answers exactly
 *      as it does for the window.
 *   4. A PRINCIPAL THAT IS NOT THE WINDOW IS REFUSED EVERY DIALOG -- the
 *      attachment picker, the mention picker, profile creation -- and the
 *      dialog is never opened.
 *   5. CONSTRUCTION FAILS CLOSED: a missing dependency refuses the surface at
 *      construction, not a command later. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require = createRequire(import.meta.url)
const surfaceModule = require('../../shell/agent-command-surface.cjs')
const {
  createAgentCommandSurface,
  COMMANDS,
  REQUIRED_DEPS,
  READ_ONLY_REFUSAL,
  DIALOG_REFUSAL,
  PASTE_WINDOW_REFUSAL,
  PRINCIPAL_REFUSAL,
  UNKNOWN_COMMAND_REFUSAL,
  ENDED_SESSION_REFUSAL,
} = surfaceModule

const MAIN = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const SURFACE_SOURCE = readFileSync(new URL('../../shell/agent-command-surface.cjs', import.meta.url), 'utf8')

/* ---------- the inventory, derived from main.cjs ---------- */

/* Every `ipcMain.handle('mc-agent:<name>'` and `ipcMain.handle('mc-org:<name>'`
   in main.cjs, mapped to the surface's command vocabulary. */
function channelsRegisteredInMain() {
  const found = []
  for (const match of MAIN.matchAll(/ipcMain\.handle\('mc-(agent|org):([a-z-]+)'/g)) {
    found.push({ channel: `mc-${match[1]}:${match[2]}`, command: `${match[1]}:${match[2]}`, at: match.index })
  }
  return found
}

test('main.cjs does not register an agent or org channel twice', () => {
  const channels = channelsRegisteredInMain()
  assert.equal(new Set(channels.map(c => c.channel)).size, channels.length, 'a channel is registered twice')
})

test('every channel main.cjs registers is a command the surface holds, and vice versa -- absence fails', () => {
  const channels = channelsRegisteredInMain()
  const surface = createAgentCommandSurface(fakeDeps())
  const known = new Set(surface.commands)
  for (const { channel, command } of channels) {
    assert.ok(known.has(command), `${channel} is registered in main.cjs but the surface has no '${command}' body`)
    assert.ok(Object.hasOwn(COMMANDS, command), `${command} is missing from the COMMANDS inventory`)
  }
  const registered = new Set(channels.map(c => c.command))
  for (const command of surface.commands) {
    assert.ok(registered.has(command), `the surface holds '${command}' but main.cjs registers no channel for it`)
  }
  assert.equal(surface.commands.length, channels.length, 'main.cjs and the surface expose different command totals')
})

test('every main.cjs wrapper forwards its own channel name to the surface, behind the Electron frame check', () => {
  const channels = channelsRegisteredInMain()
  for (const { channel, command, at } of channels) {
    /* The wrapper ends at the first close that returns to column zero. */
    const end = MAIN.indexOf(channel.startsWith('mc-org:') ? '\n' : '\n})', at)
    const wrapper = MAIN.slice(at, MAIN.indexOf('\n\n', at))
    assert.match(wrapper, new RegExp(`\\.run\\('${command.replace(/[-]/g, '\\-')}',`),
      `${channel} does not dispatch '${command}' through the shared surface`)
    assert.match(wrapper, /windowPrincipal\(event\)/, `${channel} does not build the window principal`)
    if (channel.startsWith('mc-agent:')) {
      assert.match(wrapper, /assertTrustedAgentSender\(event\)/, `${channel} skips the Electron frame check`)
    } else {
      assert.match(wrapper, /withFleetProfileSender\(event/, `${channel} skips the fleet-profile sender envelope`)
    }
    assert.ok(end > at)
  }
})

test('the surface never imports electron', () => {
  assert.doesNotMatch(SURFACE_SOURCE, /require\(['"]electron['"]\)/, 'the surface must stay free of electron so it can be tested and so a dialog can be refused')
})

/* ---------- fakes that behave like main.cjs's own helpers ---------- */

function agentIpcError(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function rendererSafeAgentError(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 && error.code.length <= 128
    ? error.code
    : 'AGENT_SESSION_FAILED'
  const safe = new Error(code)
  safe.code = code
  return safe
}

function agentPayload(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'Agent IPC payload must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'Unexpected agent IPC field: ' + key)
  }
  return value
}

function boundedAgentString(value, name, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    agentIpcError('MC_AGENT_INVALID_PAYLOAD', name + ' must be a non-empty string of at most ' + maxLength + ' characters')
  }
  return value
}

const MAX_SESSION_ID_LENGTH = 128
const AGENT_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

function parseAgentStart(value) {
  const payload = agentPayload(value, ['sessionId', 'cwd', 'surface', 'tier', 'effort', 'profileId', 'resumeThreadId', 'resumeAccount', 'accountRecovery', 'replacesSessionId', 'requestKeys', 'treeIdentity', 'roleBinding', 'boundedWork', 'treeCommandRequestId'])
  const result = { sessionId: boundedAgentString(payload.sessionId ?? 'chat-generated', 'sessionId', MAX_SESSION_ID_LENGTH) }
  if (payload.cwd !== undefined) agentIpcError('MC_AGENT_CWD_NOT_YOURS', 'A working folder cannot be sent with a start.')
  if (payload.tier !== undefined) result.tier = boundedAgentString(payload.tier, 'tier', 64)
  if (payload.effort !== undefined) result.effort = boundedAgentString(payload.effort, 'effort', 8)
  if (payload.profileId !== undefined) result.profileId = boundedAgentString(payload.profileId, 'profileId', 128)
  if (payload.resumeThreadId !== undefined) result.resumeThreadId = boundedAgentString(payload.resumeThreadId, 'resumeThreadId', 512)
  if (payload.accountRecovery !== undefined) result.accountRecovery = { ...payload.accountRecovery }
  if (payload.resumeAccount !== undefined) result.resumeAccount = boundedAgentString(payload.resumeAccount, 'resumeAccount', 64)
  if (payload.replacesSessionId !== undefined) result.replacesSessionId = boundedAgentString(payload.replacesSessionId, 'replacesSessionId', MAX_SESSION_ID_LENGTH)
  if (payload.requestKeys !== undefined) result.requestKeys = { ...payload.requestKeys }
  if (payload.treeIdentity !== undefined) result.treeIdentity = { ...payload.treeIdentity }
  if (payload.roleBinding !== undefined) result.roleBinding = { ...payload.roleBinding }
  if (payload.boundedWork !== undefined) result.boundedWork = require('../../shell/tree-bounded-work.cjs').parseBoundedWork(payload.boundedWork)
  if (payload.treeCommandRequestId !== undefined) result.treeCommandRequestId = payload.treeCommandRequestId
  return result
}

for (const phase of ['account', 'authority']) {
  test(`tree command expiry during actual host ${phase} preparation cannot reach the fixture engine`, async () => {
    const { createAgentHost } = require('../../shell/agent-host.cjs')
    const claude = require('./fixtures/dual-engine/src/lib/agent-engine/claude-cli-process.js')
    const scratch = realpathSync(os.tmpdir())
    const cwd = mkdtempSync(path.join(scratch, 'tree-command-host-expiry-'))
    const priorPlan = process.env.MC_TEST_CONFINEMENT_PLAN
    process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {}, servers: [] })
    let entered, release, expired = false, dispatched = false
    const waiting = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const bind = async () => {
      if (phase === 'authority') { entered(); await gate }
      return { bound: false, mode: 'in-process', credential: null }
    }
    const host = createAgentHost({
      enginePath: path.resolve(import.meta.dirname, 'fixtures/dual-engine/src/lib/agent-engine/codex-process.js'),
      defaultCwd: cwd, startProviderProbe: () => 'claude',
      providerCommandResolver: () => path.join(cwd, 'never-executed-fixture-claude.exe'),
      resourceGovernor: { reserve: () => ({ ok: true, token: 'reservation', state: { mode: 'off', measuredAt: null } }),
        revalidate: () => ({ ok: true }), ready() {}, release() {} },
      sessionAuthority: { bind, revoke() {}, assert: () => ({ valid: true, mode: 'in-process' }) },
      ...(phase === 'account' ? { accountResolver: async () => {
        entered(); await gate
        return { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }
      } } : {}),
    })
    const before = claude.calls.length
    const check = () => { if (!dispatched && expired) agentIpcError('MC_TREE_COMMAND_COMPLETION_TIMEOUT', 'The start request expired.') }
    const deps = fakeDeps({ getAgentHost: async () => host, chosenWorkspaceCwd: () => cwd,
      startAdmission: () => ({ assertCurrent: check, signal: new AbortController().signal,
        beginDispatch() { check(); dispatched = true },
      }),
    })
    try {
      const surface = createAgentCommandSurface(deps)
      const pending = surface.run('agent:start', { sessionId: `held-${phase}` }, window).then(result => ({ result }), error => ({ error }))
      await waiting; expired = true; release()
      const outcome = await pending
      assert.equal(outcome.result?.code, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT')
      assert.equal(outcome.result.ok, false)
      assert.equal(outcome.result.startOutcome.custody, 'none')
      assert.equal(deps.agentSessions.has(`held-${phase}`), false)
      assert.equal(dispatched, false)
      assert.equal(claude.calls.length, before, 'expiry during known host preparation must not dispatch an engine start')
    } finally {
      release()
      await host.closeAll()
      if (priorPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
      else process.env.MC_TEST_CONFINEMENT_PLAN = priorPlan
      const relative = path.relative(scratch, realpathSync(cwd))
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

for (const phase of ['audit', 'host']) {
  test(`tree start expiry during the ${phase} await refuses before native dispatch`, async () => {
    let release, entered, expired = false, dispatched = 0
    const gate = new Promise(resolve => { release = resolve })
    const waiting = new Promise(resolve => { entered = resolve })
    const requestId = 'tnc-11111111-1111-4111-8111-111111111111'
    const check = () => { if (expired) agentIpcError('MC_TREE_COMMAND_COMPLETION_TIMEOUT', 'The start request expired.') }
    const deps = fakeDeps({ startAdmission(principal, request) {
      assert.equal(principal, window)
      assert.equal(request.treeCommandRequestId, requestId)
      return { assertCurrent: check, signal: new AbortController().signal, beginDispatch() { check(); dispatched++ } }
    } })
    if (phase === 'audit') deps.recordSpawnIntent = async () => { entered(); await gate; return { sequence: 1, durable: true, signed: true } }
    else deps.getAgentHost = async () => { entered(); await gate; return deps.host }
    const surface = createAgentCommandSurface(deps)
    const pending = surface.run('agent:start', { sessionId: 'expiry-child', treeCommandRequestId: requestId }, window)
    const outcome = refusal(pending)
    await waiting; expired = true; release()
    assert.equal((await outcome).code, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT')
    assert.equal(dispatched, 0)
    assert.equal(deps.names().includes('startSession'), false)
    assert.equal(deps.agentSessions.has('expiry-child'), false)
  })
}

test('tree start marks host dispatch before a slow native receipt and never replays it', async () => {
  let release, entered, dispatched = false, expired = false, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { entered = resolve })
  const check = () => { if (!dispatched && expired) agentIpcError('MC_TREE_COMMAND_COMPLETION_TIMEOUT', 'Expired') }
  const deps = fakeDeps({ startAdmission() { return {
    assertCurrent: check, signal: new AbortController().signal,
    beginDispatch() { check(); dispatched = true },
  } } })
  deps.host.startSession = async request => {
    // This fake host marks the same engine-dispatch boundary as the real host.
    request.startAdmission.beginDispatch()
    calls++; assert.equal(dispatched, true)
    assert.equal(Object.hasOwn(request, 'treeCommandRequestId'), false, 'the opaque context is not forwarded to providers or audit')
    entered(); await gate; request.startAdmission.assertCurrent()
    return { sessionId: request.sessionId, threadId: 'retained-thread' }
  }
  const surface = createAgentCommandSurface(deps)
  const pending = surface.run('agent:start', { sessionId: 'retained-child', treeCommandRequestId: 'tnc-11111111-1111-4111-8111-111111111111' }, window)
  await waiting; expired = true; release()
  const result = await pending
  assert.equal(result.sessionId, 'retained-child')
  assert.equal(result.threadId, 'retained-thread')
  assert.equal(calls, 1)
  assert.equal(deps.agentSessions.get('retained-child').state, 'ready')
})

function parseAgentSend(value) {
  const payload = agentPayload(value, ['sessionId', 'text', 'model', 'images'])
  const request = {
    sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
    text: boundedAgentString(payload.text, 'text', 200_000),
  }
  if (payload.model !== undefined) request.model = boundedAgentString(payload.model, 'model', 128)
  if (payload.images !== undefined) {
    if (!Array.isArray(payload.images) || payload.images.length > 8) agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'images')
    request.images = payload.images.map(image => ({ path: boundedAgentString(image && image.path, 'image path', 32768) }))
  }
  return request
}

function parseAgentSessionCommand(value) {
  const payload = agentPayload(value, ['sessionId'])
  return { sessionId: boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH) }
}

const PASTE_IMAGE_MIME_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
})
const MAX_PASTE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PASTE_IMAGE_DATA_LENGTH = Math.ceil(MAX_PASTE_IMAGE_BYTES / 3) * 4 + 4

function parseAgentPasteAttachment(value) {
  const payload = agentPayload(value, ['sessionId', 'mime', 'data'])
  const sessionId = boundedAgentString(payload.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
  const mime = boundedAgentString(payload.mime, 'mime', 32)
  if (!Object.hasOwn(PASTE_IMAGE_MIME_EXTENSIONS, mime)) agentIpcError('MC_AGENT_INVALID_PAYLOAD', 'mime')
  const data = boundedAgentString(payload.data, 'data', MAX_PASTE_IMAGE_DATA_LENGTH)
  return { sessionId, mime, data }
}

/* Every dependency, with a call log, so a test can assert WHAT was touched and
   in WHAT ORDER -- and that a refused command touched nothing. */
function fixtureStartRefusal(sessionId, code, message = code) {
  return Object.assign(new Error(message), { code, startOutcome: {
    requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none',
  } })
}

function fakeDeps(overrides = {}) {
  const calls = []
  const note = (name, ...args) => { calls.push({ name, args }) }
  const host = {
    startSession: async (request) => { note('startSession', request); return { sessionId: request.sessionId, threadId: 'thread-1', tier: 'unrestricted', effort: 'medium', account: 'acct-1' } },
    sendTurn: async (request) => { note('sendTurn', request); return { sessionId: request.sessionId, threadId: 'thread-1', turnId: 'turn-1' } },
    sendTurnTracked: async (request) => {
      note('sendTurnTracked', request)
      return { ok: true, result: { sessionId: request.sessionId, threadId: 'thread-1', turnId: 'turn-tracked-1' }, deliveryDisposition: 'accepted' }
    },
    treeLinks: () => { note('treeLinks'); return { ok: true, links: [] } },
    setTreeLink: request => { note('setTreeLink', request); return { ok: true, links: [{ from: request.from, to: request.to }] } },
    updateTreeAddress: async (request) => { note('updateTreeAddress', request); return { ok: true, ...request } },
    adoptTreeAddress: async (request) => { note('adoptTreeAddress', request); return { ok: true, ...request } },
    interrupt: async (request) => { note('interrupt', request); return { sessionId: request.sessionId, turnId: 'turn-1' } },
    answerApproval: async (request) => { note('answerApproval', request); return { ...request } },
    rewindSession: async (request) => { note('rewindSession', request); return { ...request, threadId: 'thread-2' } },
    setSessionEffort: async (request) => { note('setSessionEffort', request); return { ...request } },
    listEngineModels: async (request) => { note('listEngineModels', request); return { ok: true, models: [] } },
    readSessionModes: request => { note('readSessionModes', request); return { supported: false, availableModes: [], currentModeId: null, pending: false } },
    setSessionMode: async request => { note('setSessionMode', request); return { ...request, applied: true } },
    closeSession: async (request) => { note('closeSession', request); return { sessionId: request.sessionId, closed: true } },
    startableTiers: () => { note('startableTiers'); return { ok: true, tiers: ['luna'] } },
    fileStandingRequest: async (request) => { note('fileStandingRequest', request); return { ok: true, id: 'r-1', ...request } },
    editStandingRequest: async (request) => { note('editStandingRequest', request); return { ok: true, id: request.id, scope: 'tree', key: request.key } },
    removeStandingRequest: async (request) => { note('removeStandingRequest', request); return { ok: true, id: request.id, scope: 'tree', key: request.key, removed: [request.id] } },
    decideStandingRequest: async (request) => { note('decideStandingRequest', request); return { ok: true, id: request.id, status: request.decision === 'approve' ? 'open' : 'declined' } },
    resolveStandingRequest: async (request) => { note('resolveStandingRequest', request); return { ok: true, id: request.id, status: request.status } },
    completeTask: async (request) => { note('completeTask', request); return { ok: true, id: request.id, status: 'done' } },
    removeTask: async (request) => { note('removeTask', request); return { ok: true, id: request.id, status: 'removed' } },
    answerAsk: async (request) => { note('answerAsk', request); return { ok: true, id: request.id, status: 'answered' } },
    declineAsk: async (request) => { note('declineAsk', request); return { ok: true, id: request.id, status: 'declined' } },
    removeAsk: async (request) => { note('removeAsk', request); return { ok: true, id: request.id, status: 'removed' } },
    readGoal: (request) => { note('readGoal', request); return { sessionId: request.sessionId, goal: null, sentence: 'no goal' } },
    setGoal: async (request) => { note('setGoal', request); return { sessionId: request.sessionId, goal: { objective: request.objective, status: 'active', continuations: 0 }, started: true, sentence: 'goal set' } },
    clearGoal: (request) => { note('clearGoal', request); return { sessionId: request.sessionId, goal: null, cleared: true, sentence: 'cleared' } },
  }
  const agentSessions = new Map()
  let sequence = 100
  const deps = {
    agentSessions,
    currentAgentHost: () => host,
    getAgentHost: () => { note('getAgentHost'); return host },
    agentIpcError,
    agentPayload,
    boundedAgentString,
    parseAgentStart,
    parseAgentSend,
    imageOwnerContext: () => { note('imageOwnerContext'); return { version: 1, ownerId: 'local-owner', currentEpoch: 'epoch', kind: 'local' } },
    imageQueue: request => { note('imageQueue', request); return { ok: true } },
    parseAgentSessionCommand,
    parseAgentPasteAttachment,
    MAX_PASTE_IMAGE_BYTES,
    /* A deterministic fake standing in for main.cjs's real disk write -- a
       fresh fake path per call, never a real file, so this suite never
       touches the filesystem. */
    savePasteAttachment: (mime, bytes) => {
      note('savePasteAttachment', mime, bytes.length)
      sequence += 1
      return { path: 'C:\\fake\\paste-attachments\\img-' + sequence + '.' + PASTE_IMAGE_MIME_EXTENSIONS[mime], size: bytes.length }
    },
    rendererSafeAgentError,
    spawnRecordAvailability: () => { note('spawnRecordAvailability'); return { ok: true } },
    spawnRecordHistory: (limit) => { note('spawnRecordHistory', limit); return { ok: true, total: 0, entries: [], limit } },
    usageRecordHistory: (limit) => { note('usageRecordHistory', limit); return { ok: true, total: 0, entries: [], limit } },
    engineAvailability: (options) => { note('engineAvailability', options); return { ok: true, code: 'AGENT_ENGINE_READY' } },
    ensureWorkspaceRoot: () => { note('ensureWorkspaceRoot'); return 'C:\\fake\\workspace' },
    chosenWorkspaceCwd: () => { note('chosenWorkspaceCwd'); return null },
    readAgentConfinement: (options) => { note('readAgentConfinement', options); return { ok: true, tier: 'guided' } },
    listAgentTools: (options) => { note('listAgentTools', options); return { ok: true, tier: 'guided', total: 0, tools: [] } },
    resolveCapabilityRoot: () => { note('resolveCapabilityRoot'); return 'C:\\fake\\capability' },
    requireModule: (file) => { note('requireModule', file); return { ownerJournal: async ({ limit }) => ({ ok: true, messages: [], limit }) } },
    readStandingRequests: (request) => { note('readStandingRequests', request); return { ok: true, exists: false, entries: [] } },
    readCanonicalLedger: (request) => {
      note('readCanonicalLedger', request)
      return { ok: true, revision: 0, updatedAt: null, exists: false, records: [], chain: { ok: true, events: 0, drift: [], unchained: [], code: null }, filter: request }
    },
    sessionProfiles: {
      list: () => { note('profiles.list'); return [{ id: 'p1', name: 'one' }] },
      create: (request) => { note('profiles.create', request); return { id: 'p2', ...request } },
      remove: (id) => { note('profiles.remove', id); return true },
      resolveCwd: (id) => { note('profiles.resolveCwd', id); if (id === 'missing') { const e = new Error('gone'); e.code = 'PROFILE_UNKNOWN'; throw e } return 'C:\\fake\\profile\\' + id },
    },
    recordSpawnIntent: (request) => { note('recordSpawnIntent', request); sequence += 1; return { sequence, eventHash: 'hash-' + sequence, durable: true, signed: true } },
    recordSpawnOutcome: (request, receipt, result, reason, detail) => { note('recordSpawnOutcome', request, receipt, result, reason, detail) },
    recordSessionEnd: (session, sessionId, reason) => { note('recordSessionEnd', sessionId, reason); session.ended = true },
    bindAgentOwner: (owner) => { note('bindAgentOwner', owner) },
    agentOrgRecord: {
      read: () => { note('org.read'); return { ok: true, org: {}, roles: [] } },
      resolveRoleBinding: (binding) => {
        note('org.resolveRoleBinding', binding)
        return {
          ok: true,
          role: {
            id: binding.id,
            name: 'Bound role',
            summary: null,
            owns: 'The selected work.',
            mustNot: 'Broaden the work.',
            handoff: 'Return evidence.',
            rules: [],
            revision: binding.expectedRoleRevision,
          },
        }
      },
      reparent: (r) => { note('org.reparent', r); return { ok: true, org: {} } },
      assignRole: (r) => { note('org.assignRole', r); return { ok: true, org: {} } },
      ensureSeat: (r) => { note('org.ensureSeat', r); return { ok: true, unchanged: false, org: {} } },
      releaseSeat: (r) => { note('org.releaseSeat', r); return { ok: true, unchanged: false, org: {} } },
      createRole: (r) => { note('org.createRole', r); return { ok: true, roles: [] } },
      editRole: (r) => { note('org.editRole', r); return { ok: true, roles: [] } },
      resetRole: (r) => { note('org.resetRole', r); return { ok: true, roles: [] } },
      resetOrg: () => { note('org.resetOrg'); return { ok: true, org: {} } },
      exportOrg: () => { note('org.exportOrg'); return { ok: true, document: {} } },
    },
    dialog: {
      showOpenDialog: async (options) => { note('showOpenDialog', options); return { canceled: false, filePaths: ['C:\\fake\\picked.png'] } },
    },
    MAX_AGENT_SESSIONS: 8,
    MAX_SESSION_ID_LENGTH,
    AGENT_EFFORT_VALUES,
    WORKSPACE_ROOT: 'C:\\fake\\workspace',
    ...overrides,
  }
  return Object.assign(deps, { calls, host, names: () => calls.map(c => c.name) })
}

const WINDOW_OWNER = { id: 'webContents-1' }

test('a screen grant cannot survive failed startup and a different session reusing its ID', async () => {
  const { createScreenControlHost } = require('../../shell/screen-control-host.cjs')
  const owner = { isDestroyed: () => false }
  const caller = { kind: 'window', owner, mayWrite: true, label: 'fixture window' }
  const role = { id: 'worker', revision: 1, rules: [], owns: 'Fixture work.', mustNot: 'Broaden scope.', handoff: 'Return evidence.' }
  const deps = fakeDeps()
  deps.agentOrgRecord.read = () => ({ ok: true, org: { revision: 1 }, roles: [role] })
  deps.agentOrgRecord.resolveRoleBinding = () => ({ ok: true, agent: { id: 'fixture-agent' }, role,
    authority: { agentId: 'fixture-agent', provider: 'codex', roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 } })
  const effects = []
  const screenHost = createScreenControlHost({ sessions: deps.agentSessions,
    readBinding: () => ({ enabled: true, roleId: 'worker', revision: 1, functions: ['screen.control', 'screen.status'] }),
    permissionLevel: () => 'unrestricted', audit: async () => {}, indicator: { ready: async () => {}, show() {}, hide() {}, release: async () => ({ released: true }) },
    adapter: { supported: () => true, geometry: () => ({}), validate: input => input,
      execute: async input => { effects.push(input.action); return { status: 'completed', cleanupConfirmed: true } } } })
  let entered, rejectStart
  const began = new Promise(resolve => { entered = resolve })
  let first = true
  deps.host.startSession = async request => {
    if (first) {
      first = false; entered()
      await new Promise((_resolve, reject) => { rejectStart = reject })
    }
    return { sessionId: request.sessionId, account: 'fixture', tier: 'unrestricted' }
  }
  const surface = createAgentCommandSurface(deps)
  const request = { sessionId: 'reused-screen-id', roleBinding: { agentId: 'fixture-agent', id: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 } }
  try {
    const starting = surface.run('agent:start', request, caller)
    await began
    const original = deps.agentSessions.get(request.sessionId)
    assert.equal(original.state, 'starting')
    await screenHost.grant(owner, { mode: 'selected', sessionIds: [request.sessionId] })
    rejectStart(fixtureStartRefusal(request.sessionId, 'AGENT_ENGINE_MISSING', 'Fixture startup refusal; no provider was launched.'))
    const refused = await starting
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'AGENT_ENGINE_MISSING')
    assert.equal(deps.agentSessions.has(request.sessionId), false, 'the real command surface rolls the failed attempt back')
    await surface.run('agent:start', request, caller)
    assert.notEqual(deps.agentSessions.get(request.sessionId), original)
    const principal = { kind: 'agent-session', sessionId: request.sessionId, agentId: 'fixture-agent', roleId: 'worker', expectedRoleRevision: 1 }
    await assert.rejects(async () => screenHost.control(principal, { action: 'click' }), { code: 'SCREEN_ACCESS_CHANGED' })
    assert.deepEqual(effects, [])
    await screenHost.grant(owner, { mode: 'selected', sessionIds: [request.sessionId] })
    await screenHost.control(principal, { action: 'click' })
    assert.deepEqual(effects, ['click'], 'a fresh grant explicitly authorizes the replacement session')
  } finally { screenHost.close(owner) }
})

test('actual command-surface close rechecks lifecycle immediately before host close and never forwards the token', async () => {
  const order = []
  const deps = fakeDeps({
    assertTreeLifecycleClose: (token, sessionId) => { assert.equal(token, 'grant'); assert.equal(sessionId, 'old'); order.push('verify') },
    rememberTreeAdmission: () => order.push('retain'),
  })
  deps.agentSessions.set('old', { owner: WINDOW_OWNER, ownerKind: 'window', state: 'ready' })
  deps.host.closeSession = async request => { assert.deepEqual(request, { sessionId: 'old' }); order.push('close'); return { ok: true } }
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:close', { sessionId: 'old', delegationToken: 'grant' }, window)
  assert.deepEqual(order, ['verify', 'retain', 'verify', 'close'])
})

test('pre-close authority refusal keeps the exact old session and performs zero closes', async () => {
  const deps = fakeDeps({ assertTreeLifecycleClose: () => { throw Object.assign(new Error('refused'), { code: 'TREE_DELEGATION_REFUSED' }) } })
  const old = { owner: WINDOW_OWNER, ownerKind: 'window', state: 'ready' }
  deps.agentSessions.set('old', old)
  const surface = createAgentCommandSurface(deps)
  await assert.rejects(surface.run('agent:close', { sessionId: 'old', delegationToken: 'grant' }, window), { code: 'TREE_DELEGATION_REFUSED' })
  assert.equal(deps.agentSessions.get('old'), old)
  assert.ok(!deps.names().includes('closeSession'))
})
const OTHER_OWNER = { id: 'webContents-2' }
const window = Object.freeze({ kind: 'window', owner: WINDOW_OWNER, mayWrite: true, label: 'the application window' })
const otherWindow = Object.freeze({ kind: 'window', owner: OTHER_OWNER, mayWrite: true, label: 'another window' })
const readOnly = Object.freeze({ kind: 'window', owner: WINDOW_OWNER, mayWrite: false, label: 'a read-only caller' })
/* A principal that is NOT at the keyboard. Its kind is deliberately not
   'relay' -- no relay principal exists yet and this suite does not invent one;
   the surface's rule is "not the window", whatever the other kind is called. */
const elsewhere = Object.freeze({ kind: 'elsewhere', owner: { id: 'remote-1' }, mayWrite: true, label: 'a caller that is not at the keyboard' })

const boundedRequest = () => ({ sessionId: 'bounded-child', boundedWork: {
  computerId: 'computer', treeId: 'tree', parentNodeId: 'parent', parentSessionId: 'parent-session', capMs: 60000,
} })

test('bounded starts sign the private admitted parent and retain the actual receipt after completion for only their owner', async () => {
  let ended = false
  const details = { action: 'tree.dispatch', ...boundedRequest().boundedWork, nodeId: 'child', sessionId: 'bounded-child',
    agentId: 'child', startedAt: 1000, deadlineAt: 61000 }
  const permit = { details, assertStart() {}, cancel() {}, remainingMs: () => 60000 }
  const deps = fakeDeps({ beginBoundedTreeStart: (request, principal) => {
    assert.equal(principal, window)
    assert.equal(request.boundedWork.parentNodeId, 'parent')
    return permit
  } })
  deps.host.startSession = async request => {
    assert.equal(request.boundedWorkPermit, permit)
    assert.equal(deps.calls.find(call => call.name === 'recordSpawnIntent').args[0].boundedWorkPermit, permit)
    return { sessionId: request.sessionId, boundedWork: { ...details, state: 'ready' } }
  }
  deps.host.boundedWorkStatus = () => ({ ...details, state: ended ? 'closed' : 'ready', reason: ended ? 'cap-reached' : null })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', boundedRequest(), window)
  assert.deepEqual(result.record, { sequence: 101, eventHash: 'hash-101' })
  const outer = deps.agentSessions.get('bounded-child')
  ended = true
  outer.endRecord = { sequence: 102, eventHash: 'hash-102' }
  deps.agentSessions.delete('bounded-child')
  const status = await surface.run('agent:work-status', { sessionId: 'bounded-child' }, readOnly)
  assert.equal(status.state, 'closed')
  assert.deepEqual(status.record, result.record)
  assert.deepEqual(status.endRecord, outer.endRecord)
  for (const principal of [otherWindow, { ...window, kind: 'relay' }]) {
    assert.deepEqual(await surface.run('agent:work-status', { sessionId: 'bounded-child' }, principal), { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' })
  }
})

test('bounded work refuses a missing authority, a stale parent and remote ownership before audit or any process start', async () => {
  for (const scenario of ['missing', 'stale', 'remote']) {
    const deps = fakeDeps(scenario === 'missing' ? {} : { beginBoundedTreeStart: () => agentIpcError('MC_TREE_BOUNDED_WORK_REFUSED', 'changed parent') })
    const surface = createAgentCommandSurface(deps)
    await assert.rejects(surface.run('agent:start', boundedRequest(), scenario === 'remote' ? elsewhere : window), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
    assert.ok(!deps.names().includes('recordSpawnIntent'))
    assert.ok(!deps.names().includes('startSession'))
  }
})

test('nested remaining-cap admission is signed before the child starts, even without a renderer boundedWork field', async () => {
  const permit = { details: { action: 'tree.delegate', sessionId: 'nested', parentSessionId: 'bounded', capMs: 17 },
    assertStart() {}, cancel() {}, remainingMs: () => 17 }
  const deps = fakeDeps({ inheritBoundedTreeStart: request => { assert.equal(request.boundedWork, undefined); return permit } })
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'nested' }, window)
  assert.equal(deps.calls.find(call => call.name === 'recordSpawnIntent').args[0].boundedWorkPermit, permit)
  assert.equal(deps.calls.find(call => call.name === 'startSession').args[0].boundedWorkPermit, permit)
})

test('reusing an ended bounded session id for an ordinary start cannot lend the old receipt to the new process', async () => {
  const permit = { details: { sessionId: 'bounded-child' }, assertStart() {}, cancel() {}, remainingMs: () => 60000 }
  const deps = fakeDeps({ beginBoundedTreeStart: () => permit })
  deps.host.boundedWorkStatus = () => ({ sessionId: 'bounded-child', state: 'closed' })
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', boundedRequest(), window)
  await surface.run('agent:close', { sessionId: 'bounded-child' }, window)
  await surface.run('agent:start', { sessionId: 'bounded-child' }, window)
  assert.deepEqual(await surface.run('agent:work-status', { sessionId: 'bounded-child' }, window), { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' })
})

test('a renderer cannot supply the private bounded admission object', async () => {
  const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
  await assert.rejects(surface.run('agent:start', { sessionId: 'forged', boundedWorkPermit: { details: {} } }, window), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  assert.deepEqual(deps.names(), [])
})

async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected a refusal')
}

/* A session owned by the window, as start leaves it. */
async function startedSession(deps, surface, sessionId = 'chat-1', principal = window) {
  const result = await surface.run('agent:start', { sessionId }, principal)
  deps.calls.length = 0
  return result
}

/* ---------- construction fails closed ---------- */

test('a missing dependency refuses construction, by name', () => {
  for (const name of Object.keys(REQUIRED_DEPS)) {
    const deps = fakeDeps()
    delete deps[name]
    assert.throws(() => createAgentCommandSurface(deps), new RegExp(name), `construction proceeded without ${name}`)
  }
  assert.throws(() => createAgentCommandSurface(), /explicit deps/)
  assert.throws(() => createAgentCommandSurface(fakeDeps({ dialog: {} })), /showOpenDialog/)
})

test('an unknown command and an unshaped principal are refused before anything runs', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal((await refusal(surface.run('agent:nope', {}, window))).code, UNKNOWN_COMMAND_REFUSAL)
  for (const bad of [null, undefined, {}, { kind: 'window' }, { kind: 'window', owner: WINDOW_OWNER }, { kind: 'window', owner: WINDOW_OWNER, mayWrite: 'yes', label: 'x' }, { kind: 'window', owner: null, mayWrite: true, label: 'x' }]) {
    assert.equal((await refusal(surface.run('agent:history', {}, bad))).code, PRINCIPAL_REFUSAL)
  }
  assert.deepEqual(deps.names(), [], 'a refused call touched a dependency')
})

/* ---------- the window principal, command by command ---------- */

test('availability: the recorder is asked first, then the engine about the prepared workspace', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  const answer = await surface.run('agent:availability', undefined, window)
  assert.deepEqual(answer, { ok: true, code: 'AGENT_ENGINE_READY' })
  assert.deepEqual(deps.names(), ['spawnRecordAvailability', 'ensureWorkspaceRoot', 'engineAvailability'])
  assert.deepEqual(deps.calls[2].args[0], { defaultCwd: 'C:\\fake\\workspace' })

  const refused = fakeDeps({ spawnRecordAvailability: () => ({ ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' }) })
  const answer2 = await createAgentCommandSurface(refused).run('agent:availability', {}, window)
  assert.deepEqual(answer2, { ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' })
  assert.ok(!refused.names().includes('engineAvailability'), 'the engine was asked after the recorder refused')
  assert.equal((await refusal(surface.run('agent:availability', { extra: 1 }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
})

test('availability uses Local runtime evidence only after a provider-specific refusal and rechecks shared fences', async () => {
  for (const code of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT']) {
    const calls = []
    const local = { ok: true, ready: true }
    const deps = fakeDeps({
      detectLocal: async () => { calls.push('local'); return local },
      engineAvailability: options => {
        calls.push(options)
        return options.localRuntime === local ? { ok: true, code: 'AGENT_ENGINE_READY', readyProvider: 'local', codexCode: code } : { ok: false, code }
      },
    })
    const answer = await createAgentCommandSurface(deps).run('agent:availability', {}, window)
    assert.equal(answer.readyProvider, 'local')
    assert.deepEqual(calls, [{ defaultCwd: 'C:\\fake\\workspace' }, 'local', { defaultCwd: 'C:\\fake\\workspace', localRuntime: local }])
  }
  for (const first of [{ ok: true, code: 'AGENT_ENGINE_READY' }, { ok: false, code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' }]) {
    let probes = 0
    const deps = fakeDeps({ engineAvailability: () => first, detectLocal: async () => { probes++; return { ok: true, ready: true } } })
    assert.deepEqual(await createAgentCommandSurface(deps).run('agent:availability', {}, window), first)
    assert.equal(probes, 0)
  }
  const deps = fakeDeps({
    detectLocal: async () => ({ ok: true, ready: true }),
    engineAvailability: options => options.localRuntime ? { ok: false, code: 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE' } : { ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' },
  })
  assert.equal((await createAgentCommandSurface(deps).run('agent:availability', {}, window)).code, 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE')
})

test('availability does not turn absent, malformed, or failed Local probes into readiness', async () => {
  for (const detectLocal of [undefined, async () => null, async () => ({ ok: false, ready: true }), async () => ({ ok: true, ready: false }), async () => ({ ok: true, ready: 'true' }), async () => { throw Error('probe failed') }]) {
    let reads = 0
    const refusal = { ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' }
    const deps = fakeDeps({ detectLocal, engineAvailability: () => { reads++; return refusal } })
    assert.deepEqual(await createAgentCommandSurface(deps).run('agent:availability', {}, window), refusal)
    assert.equal(reads, detectLocal ? 2 : 1, 'every attempted asynchronous read must refresh common readiness')
  }
})

test('Local can answer an unknown hosted sign-in, using a fresh workspace after the runtime read', async () => {
  let cwd = 'C:\\fake\\before', reads = 0
  const deps = fakeDeps({
    ensureWorkspaceRoot: () => cwd,
    detectLocal: async () => { cwd = 'C:\\fake\\after'; return { ok: true, ready: true } },
    engineAvailability: options => {
      reads++
      assert.equal(options.defaultCwd, cwd)
      return options.localRuntime ? { ok: true, readyProvider: 'local' }
        : { ok: true, readyProvider: 'claude', codexCode: 'AGENT_CONFINEMENT_SIGNED_OUT' }
    },
  })
  assert.equal((await createAgentCommandSurface(deps).run('agent:availability', {}, window)).readyProvider, 'local')
  assert.equal(reads, 2)
})

test('a failed Local probe cannot retain a hosted readiness verdict from before a global refusal', async () => {
  for (const failProbe of [false, true]) {
    let afterProbe = false
    const deps = fakeDeps({
      detectLocal: async () => { afterProbe = true; if (failProbe) throw Error('probe unavailable'); return { ok: true, ready: false } },
      engineAvailability: () => afterProbe ? { ok: false, code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' }
        : { ok: true, readyProvider: 'claude', codexCode: 'AGENT_CONFINEMENT_SIGNED_OUT' },
    })
    const answer = await createAgentCommandSurface(deps).run('agent:availability', {}, window)
    assert.deepEqual(answer, { ok: false, code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE' })
  }
})

test('a recorder refusal during Local detection remains a refusal and does not call the engine again', async () => {
  let recordReads = 0, engineReads = 0
  const deps = fakeDeps({
    spawnRecordAvailability: () => ++recordReads === 1 ? { ok: true } : { ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' },
    engineAvailability: () => { engineReads++; return { ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' } },
    detectLocal: async () => ({ ok: true, ready: true }),
  })
  assert.deepEqual(await createAgentCommandSurface(deps).run('agent:availability', {}, window), { ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' })
  assert.equal(engineReads, 1)
  assert.match(MAIN, /detectLocal: \(\) => providerLoginService\.detectLocal\(\)/,
    'the common command must receive the maintained runtime detector, not a readiness constant')
})

test('confinement and tools read through the capability root', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.deepEqual(await surface.run('agent:confinement', undefined, window), { ok: true, tier: 'guided' })
  assert.deepEqual(deps.calls.at(-1), { name: 'readAgentConfinement', args: [{ capabilityRoot: 'C:\\fake\\capability' }] })
  assert.deepEqual(await surface.run('agent:tools', undefined, window), { ok: true, tier: 'guided', total: 0, tools: [] })
  assert.deepEqual(deps.calls.at(-1), { name: 'listAgentTools', args: [{ capabilityRoot: 'C:\\fake\\capability' }] })
})

test('local-messages bounds the limit, loads the journal from the engine root, and degrades honestly', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.deepEqual(await surface.run('agent:local-messages', { limit: 5000 }, window), { ok: true, messages: [], limit: 200 })
  assert.deepEqual(await surface.run('agent:local-messages', { limit: 0 }, window), { ok: true, messages: [], limit: 1 })
  assert.deepEqual(await surface.run('agent:local-messages', undefined, window), { ok: true, messages: [], limit: 100 })
  assert.match(deps.calls.find(c => c.name === 'requireModule').args[0], /agent-comms-local\.js$/)
  const absent = createAgentCommandSurface(fakeDeps({ resolveCapabilityRoot: () => null }))
  assert.deepEqual(await absent.run('agent:local-messages', {}, window), { ok: false, reason: 'the live message reader is not available in this build' })
  const broken = createAgentCommandSurface(fakeDeps({ requireModule: () => { throw new Error('C:\\secret\\path') } }))
  assert.deepEqual(await broken.run('agent:local-messages', {}, window), { ok: false, reason: 'the live message reader is not available in this build' })
})

test('startable-tiers builds the host and asks it', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.deepEqual(await surface.run('agent:startable-tiers', undefined, window), { ok: true, tiers: ['luna'] })
  assert.deepEqual(deps.names(), ['getAgentHost', 'startableTiers'])
})

test('history and usage pass the bounded limit to their recorder and nothing else', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.deepEqual(await surface.run('agent:history', { limit: 7 }, window), { ok: true, total: 0, entries: [], limit: 7 })
  assert.deepEqual(await surface.run('agent:history', null, window), { ok: true, total: 0, entries: [], limit: undefined })
  assert.deepEqual(await surface.run('agent:usage', { limit: 3 }, window), { ok: true, total: 0, entries: [], limit: 3 })
  assert.deepEqual(deps.names(), ['spawnRecordHistory', 'spawnRecordHistory', 'usageRecordHistory'])
  assert.equal((await refusal(surface.run('agent:history', { scope: 'x' }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
  for (const forbidden of ['startSession', 'sendTurn', 'getAgentHost', 'recordSpawnIntent']) {
    assert.ok(!deps.names().includes(forbidden), `a read channel touched ${forbidden}`)
  }
})

test('start: records BEFORE it spawns, owns the session by the principal, and carries the receipt back', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'chat-1', tier: 'luna' }, window)
  assert.deepEqual(result, {
    sessionId: 'chat-1', threadId: 'thread-1', tier: 'unrestricted', effort: 'medium', account: 'acct-1',
    record: { sequence: 101, eventHash: 'hash-101' },
    audit: { sequence: 101, eventHash: 'hash-101' },
  })
  const names = deps.names()
  assert.ok(names.indexOf('recordSpawnIntent') < names.indexOf('startSession'), 'the record is written first')
  assert.ok(names.indexOf('chosenWorkspaceCwd') < names.indexOf('recordSpawnIntent'), 'the chosen folder is resolved before the record')
  assert.equal(names.filter(n => n === 'startSession').length, 1, 'exactly one spawn')
  assert.deepEqual(deps.calls.find(c => c.name === 'bindAgentOwner').args, [WINDOW_OWNER])
  const session = deps.agentSessions.get('chat-1')
  assert.equal(session.owner, WINDOW_OWNER)
  assert.equal(session.state, 'ready')
  assert.equal(session.tier, 'luna', 'the MODEL ROW the person chose, not the confinement level')
  assert.equal(session.account, 'acct-1')
  assert.deepEqual(session.started, { sequence: 101 })
  assert.equal(session.turnsCompleted, 0)
  const outcome = deps.calls.find(c => c.name === 'recordSpawnOutcome')
  assert.equal(outcome.args[2], 'started')
})

test('Metrics requests pass a bounded period but cannot name the account to read', async () => {
  const metrics = { fromMs: 1000, toMs: 2000 }
  const deps = fakeDeps({
    spawnRecordHistory: (limit, query) => ({ limit, query }),
    usageRecordHistory: (limit, query) => ({ limit, query }),
  })
  const surface = createAgentCommandSurface(deps)
  for (const channel of ['agent:history', 'agent:usage']) {
    assert.deepEqual(await surface.run(channel, { limit: 200, metrics }, window), { limit: 200, query: metrics })
    assert.equal((await refusal(surface.run(channel, { metrics: { ...metrics, principal: 'account:' + 'b'.repeat(32) } }, window))).code, 'METRICS_QUERY_INVALID')
  }
})

test('a running session retains the account from its trusted start receipt', async () => {
  const principal = 'account:' + 'a'.repeat(32)
  const deps = fakeDeps({ recordSpawnIntent: () => ({ sequence: 1, durable: true, signed: true, principal }) })
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'metric-owned-start', tier: 'luna' }, window)
  assert.equal(deps.agentSessions.get('metric-owned-start').metricsPrincipal, principal)
})

test('local Metrics admits explicit computer scope while rejecting arbitrary scope or principal selection', async () => {
  const deps = fakeDeps({ spawnRecordHistory: (limit, metrics) => ({ limit, metrics }), usageRecordHistory: (limit, metrics) => ({ limit, metrics }) })
  const surface = createAgentCommandSurface(deps)
  const metrics = { fromMs: 1000, toMs: 2000, scope: 'computer' }
  for (const command of ['agent:history', 'agent:usage']) {
    assert.deepEqual(await surface.run(command, { limit: 200, metrics }, window), { limit: 200, metrics })
    for (const extra of [{ scope: 'all-accounts' }, { principal: 'account:' + 'b'.repeat(32) }]) {
      assert.equal((await refusal(surface.run(command, { metrics: { ...metrics, ...extra } }, window))).code, 'METRICS_QUERY_INVALID')
    }
  }
})

test('start: a resume seeds turnsCompleted from the engine\'s own resumed count, so the end record does not drop the prior conversation', async () => {
  const deps = fakeDeps()
  deps.host.startSession = async (request) => ({
    sessionId: request.sessionId, threadId: 'thread-old', tier: 'unrestricted', effort: 'medium', account: 'acct-1',
    resumed: { turns: [{ turnId: 't1' }, { turnId: 't2' }, { turnId: 't3' }], turnCount: 3 },
  })
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'chat-resumed', resumeThreadId: 'thread-old' }, window)
  assert.equal(deps.agentSessions.get('chat-resumed').turnsCompleted, 3,
    'the three turns the engine restored must count toward this session\'s own end record')

  /* A resumed thread with nothing in it yet, and a malformed count from a
     future/foreign engine shape, both leave the zero-turn default alone --
     seeding must never invent a count the engine did not report. */
  const zero = fakeDeps()
  zero.host.startSession = async (request) => ({
    sessionId: request.sessionId, threadId: 'thread-empty', tier: 'unrestricted', effort: 'medium', account: null,
    resumed: { turns: [], turnCount: 0 },
  })
  await createAgentCommandSurface(zero).run('agent:start', { sessionId: 'chat-empty-resume', resumeThreadId: 'thread-empty' }, window)
  assert.equal(zero.agentSessions.get('chat-empty-resume').turnsCompleted, 0)

  const malformed = fakeDeps()
  malformed.host.startSession = async (request) => ({
    sessionId: request.sessionId, threadId: 'thread-bad', tier: 'unrestricted', effort: 'medium', account: null,
    resumed: { turns: [], turnCount: 'three' },
  })
  await createAgentCommandSurface(malformed).run('agent:start', { sessionId: 'chat-bad-resume', resumeThreadId: 'thread-bad' }, window)
  assert.equal(malformed.agentSessions.get('chat-bad-resume').turnsCompleted, 0)
})

test('start: the saved account owner reaches the host with the thread it owns', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', {
    sessionId: 'chat-account-resume',
    resumeThreadId: 'thread-owned',
    resumeAccount: 'work-account',
  }, window)
  const request = deps.calls.find(call => call.name === 'startSession').args[0]
  assert.equal(request.resumeThreadId, 'thread-owned')
  assert.equal(request.resumeAccount, 'work-account')
})

test('start: a clean replacement carries the exact prior session to the host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', {
    sessionId: 'chat-after-restart',
    replacesSessionId: 'chat-before-restart',
    treeIdentity: { selfName: 'Worker', managerName: 'Manager' },
  }, window)
  const request = deps.calls.find(call => call.name === 'startSession').args[0]
  assert.equal(request.replacesSessionId, 'chat-before-restart')
  assert.deepEqual(request.treeIdentity, { selfName: 'Worker', managerName: 'Manager' })
})

test('start: a resume whose child had already exited still ends with its true resumed turn count, not zero', async () => {
  const deps = fakeDeps()
  let endedSession = null
  deps.recordSessionEnd = (session, sessionId, reason) => {
    deps.calls.push({ name: 'recordSessionEnd', args: [sessionId, reason] })
    endedSession = session
    session.ended = true
  }
  deps.host.startSession = async (request) => {
    const session = deps.agentSessions.get(request.sessionId)
    session.state = 'ended'
    session.exitedBeforeStarted = true
    return {
      sessionId: request.sessionId, threadId: 'thread-old', tier: 'unrestricted', effort: 'medium', account: null,
      resumed: { turns: [{ turnId: 't1' }, { turnId: 't2' }], turnCount: 2 },
    }
  }
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'chat-resumed-gone', resumeThreadId: 'thread-old' }, window)
  assert.ok(endedSession, 'recordSessionEnd was called for the already-exited resume')
  assert.equal(endedSession.turnsCompleted, 2, 'the end record must not report zero turns for a conversation that had two')
})

test('start: a role identity is resolved before the spawn record and only authoritative directions reach the host', async () => {
  const authoritative = {
    id: 'release-scribe',
    name: 'Release scribe',
    summary: null,
    owns: 'Record release evidence.',
    mustNot: 'Change release inputs.',
    handoff: 'Return the evidence to the dispatcher.',
    rules: [],
    revision: 4,
  }
  const deps = fakeDeps({
    agentOrgRecord: {
      ...fakeDeps().agentOrgRecord,
      read: () => ({ ok: true, org: { revision: 7 } }),
      resolveRoleBinding: (binding) => {
        deps.calls.push({ name: 'org.resolveRoleBinding', args: [binding] })
        return {
          ok: true,
          agent: { id: 'tree-worker-7' },
          authority: {
            agentId: 'tree-worker-7',
            provider: 'codex',
            roleId: 'release-scribe',
            expectedOrgRevision: 7,
            expectedRoleRevision: 4,
          },
          role: authoritative,
        }
      },
    },
  })
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', {
    sessionId: 'role-bound',
    roleBinding: { agentId: 'tree-worker-7', id: 'release-scribe', expectedOrgRevision: 7, expectedRoleRevision: 4 },
  }, window)

  const names = deps.names()
  assert.ok(names.indexOf('org.resolveRoleBinding') < names.indexOf('recordSpawnIntent'))
  assert.ok(names.indexOf('org.resolveRoleBinding') < names.indexOf('startSession'))
  const request = deps.calls.find(call => call.name === 'startSession').args[0]
  assert.equal(request.roleBinding, undefined, 'the untrusted renderer packet reached the host')
  assert.deepEqual(request.role, authoritative, 'the host did not receive the store definition')
  assert.equal(request.agentId, 'tree-worker-7', 'the resolved declared actor reaches the host')
  assert.deepEqual(deps.calls.find(call => call.name === 'recordSpawnIntent').args[0], request,
    'the signed intent receives the same authoritative actor as the host')
  assert.equal(deps.agentSessions.get('role-bound').agentId, 'tree-worker-7',
    'the outcome and eventual end can keep naming the actor after the request scope ends')
})

test('start: the authoritative empty choice keeps its exact identity and survives the retained continuation descriptor', async () => {
  const deps = fakeDeps(), retained = []
  const role = { id: 'worker', name: 'Worker', owns: 'Assigned Worker instructions.', mustNot: 'Broaden.', handoff: 'Report.', rules: [], revision: 4 }
  const authority = { agentId: 'tree-blank', provider: 'codex', roleId: 'worker', expectedOrgRevision: 7, expectedRoleRevision: 4 }
  deps.agentOrgRecord.read = () => ({ ok: true, org: { revision: 7 } })
  deps.agentOrgRecord.resolveRoleBinding = binding => {
    assert.equal(binding.selection, '', 'fresh admission must retain the persisted choice as well as the original resolution')
    return { ok: true, role, authority, agent: { id: authority.agentId }, roleSelection: '' }
  }
  deps.host.rememberContinuation = (sessionId, defaults) => retained.push({ sessionId, defaults: structuredClone(defaults) })
  const surface = createAgentCommandSurface(deps)
  const roleBinding = { agentId: authority.agentId, id: 'worker', expectedOrgRevision: 7, expectedRoleRevision: 4, selection: '' }
  const treeIdentity = { selfName: 'Assistant', managerName: null }
  await surface.run('agent:start', { sessionId: 'blank', treeIdentity, roleBinding }, window)
  const first = deps.calls.find(call => call.name === 'startSession').args[0]
  assert.equal(first.roleSelection, '')
  assert.deepEqual(first.role, role, 'the empty choice does not strip authority policy from the host input')
  assert.deepEqual(first.agentAuthority, authority)
  assert.deepEqual(retained[0].defaults.roleBinding, roleBinding)
  await surface.run('agent:start', { ...JSON.parse(JSON.stringify(retained[0].defaults)), sessionId: 'blank-resumed',
    treeIdentity, resumeThreadId: 'saved-thread' }, window)
  const resumed = deps.calls.filter(call => call.name === 'startSession').at(-1).args[0]
  assert.equal(resumed.roleSelection, '')
  assert.deepEqual(resumed.agentAuthority, authority)
  assert.equal(deps.agentSessions.get('blank-resumed').agentId, authority.agentId)
})

test('org:ensure-seat accepts only a node-bound Worker selection and forwards it to the authoritative store', async () => {
  const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
  const request = { id: 'tree-blank', nodeId: 'tree-blank', role: 'worker', roleSelection: '', expectedRevision: 4 }
  await surface.run('org:ensure-seat', request, window)
  assert.equal(deps.calls.at(-1).args[0].roleSelection, '')
  for (const change of [{ role: 'manager' }, { nodeId: undefined }, { roleSelection: false }, { roleSelection: 'other' }]) {
    deps.calls.length = 0
    const refused = await refusal(surface.run('org:ensure-seat', { ...request, ...change }, window))
    assert.equal(refused.code, 'MC_AGENT_SEAT_ROLE_INVALID')
    assert.deepEqual(deps.calls, [])
  }
})

test('start: forged and stale role packets refuse before a record, session, or child exists', async () => {
  for (const [code, reason] of [
    ['MC_AGENT_ROLE_UNKNOWN', 'not in the library'],
    ['MC_AGENT_ROLE_STALE', 'changed'],
  ]) {
    const deps = fakeDeps()
    deps.agentOrgRecord.resolveRoleBinding = (binding) => {
      deps.calls.push({ name: 'org.resolveRoleBinding', args: [binding] })
      return { ok: false, code, reason }
    }
    const surface = createAgentCommandSurface(deps)
    const refused = await refusal(surface.run('agent:start', {
      sessionId: `refused-${code}`,
      roleBinding: { id: 'forged-role', expectedOrgRevision: 1, expectedRoleRevision: 1 },
    }, window))
    assert.equal(refused.code, code)
    assert.deepEqual(deps.names(), ['org.resolveRoleBinding'], `${code} touched work after authoritative resolution refused`)
    assert.equal(deps.agentSessions.size, 0)
  }
})

test('start: a profile is resolved in the main process, a missing one refuses by name, and cwd falls back to the chosen workspace', async () => {
  const deps = fakeDeps({ chosenWorkspaceCwd: () => 'C:\\fake\\chosen' })
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'a', profileId: 'p1' }, window)
  const spawned = deps.calls.find(c => c.name === 'startSession').args[0]
  assert.equal(spawned.cwd, 'C:\\fake\\profile\\p1')
  assert.equal(deps.agentSessions.get('a').cwd, spawned.cwd, 'changed file paths retain the session profile folder')
  assert.equal(deps.agentSessions.get('a').profileId, 'p1', 'native review retains the selected registered ID')
  assert.equal(spawned.profileId, undefined, 'profileId does not reach the host')
  await surface.run('agent:start', { sessionId: 'b' }, window)
  assert.equal(deps.calls.filter(c => c.name === 'startSession')[1].args[0].cwd, 'C:\\fake\\chosen')
  assert.equal(deps.agentSessions.get('b').cwd, 'C:\\fake\\chosen', 'the session captures the workspace selected at start')
  assert.equal(deps.agentSessions.get('b').profileId, null, 'default workspace never gains a made-up profile')
  const refused = await refusal(surface.run('agent:start', { sessionId: 'c', profileId: 'missing' }, window))
  assert.equal(refused.code, 'MC_AGENT_PROFILE_UNKNOWN')
  assert.ok(!deps.agentSessions.has('c'))
  assert.equal((await refusal(surface.run('agent:start', { sessionId: 'd', cwd: 'C:\\anywhere' }, window))).code, 'MC_AGENT_CWD_NOT_YOURS')
})

test('start: a session that already exists refuses before anything is recorded, and NOTHING refuses for being the nth', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'one' }, window)
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:start', { sessionId: 'one' }, window))).code, 'MC_AGENT_SESSION_EXISTS')
  assert.ok(!deps.names().includes('recordSpawnIntent'), 'a refused start records no intent')

  /* THE CEILING IS GONE (owner, 2026-09-03: it was never supposed to exist).
     Twelve is the number in the request that found it -- a tree of twelve
     workers -- so twelve is what this starts, and every one of them starts. */
  for (let index = 0; index < 12; index += 1) {
    const answer = await surface.run('agent:start', { sessionId: `worker-${index}` }, window)
    assert.ok(answer && answer.ok !== false, `worker-${index} was refused`)
  }
  assert.equal(surface.sessionLoad().open, 13, 'all thirteen are open at once')
  assert.equal(surface.sessionLoad().max, null, 'and the load reports no maximum, because there is none')
})

/* A SESSION TOMBSTONE KEPT FOR A FAILED CLEANUP MUST NOT BE COUNTED AS OPEN.
 *
 * The normal observed-exit path removes both maps after its terminal event.
 * The host deliberately retains an ended tombstone only when adapter cleanup
 * fails so closeAll can retry the one close handle. That exceptional entry must
 * neither be sendable nor occupy a live-session slot.
 *
 * The leak also disabled the one automatic recovery: the renderer is never told
 * a child died, so nobody presses Stop, and the dead-session recovery fires
 * only on MC_AGENT_UNKNOWN_SESSION -- which needs the entry to be ABSENT. So
 * this is asserted with the entry still present, which is the whole point. */
test('start: an ended cleanup tombstone is not counted among the running', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'one' }, window)
  await surface.run('agent:start', { sessionId: 'two' }, window)
  assert.equal(surface.sessionLoad().open, 2)

  // Stand in for the narrow state retained only after terminal cleanup failed.
  deps.agentSessions.get('one').ended = true
  deps.agentSessions.get('one').state = 'ended'
  assert.ok(deps.agentSessions.has('one'), 'the cleanup tombstone is still present')

  /* It no longer blocks anything -- nothing does -- but the number a person
     reads has to mean what it says, and a corpse is not a running agent. */
  assert.equal(surface.sessionLoad().open, 1, 'the load a person is shown no longer counts the corpse')
  await surface.run('agent:start', { sessionId: 'three' }, window)
  assert.ok(deps.agentSessions.has('three'))
  assert.equal(surface.sessionLoad().open, 2)
})

test('ended sessions refuse every adapter-driving command by name without leaking state across owners', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  deps.agentSessions.set('ended-1', {
    owner: WINDOW_OWNER,
    ownerKind: 'window',
    state: 'ended',
    ended: true,
    attachments: new Set(),
  })
  const cases = [
    ['agent:send', { sessionId: 'ended-1', text: 'do not deliver' }],
    ['agent:tree-address', { sessionId: 'ended-1', selfName: 'Worker', managerName: 'Manager', treeKey: 'tree-1' }],
    ['agent:tree-adopt', { sessionId: 'ended-1', selfName: 'Worker', treeKey: 'node-1', requestKeys: { treeAnchors: ['node-1'], threadId: 'node-1' } }],
    ['agent:interrupt', { sessionId: 'ended-1' }],
    ['agent:approval-answer', { sessionId: 'ended-1', approvalId: 'ap-1', decision: 'approve' }],
    ['agent:rewind', { sessionId: 'ended-1', turnId: 'turn-1' }],
    ['agent:effort', { sessionId: 'ended-1', effort: 'high' }],
    ['agent:models', { sessionId: 'ended-1' }],
    ['agent:pick-attachment', { sessionId: 'ended-1' }],
    ['agent:paste-attachment', { sessionId: 'ended-1', mime: 'image/png', data: 'QQ==' }],
    ['agent:close', { sessionId: 'ended-1' }],
  ]
  for (const [command, payload] of cases) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run(command, payload, window))).code, ENDED_SESSION_REFUSAL, command)
    assert.deepEqual(deps.names(), [], `${command} touched an adapter, dialog or recorder after exit`)
    assert.equal((await refusal(surface.run(command, payload, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION',
      `${command} disclosed another owner's ended session`)
  }
  assert.equal(ENDED_SESSION_REFUSAL, 'MC_AGENT_SESSION_ENDED')
})

test('a child exit replayed while start resolves is recorded once, never revived, and leaves no outer corpse', async () => {
  const deps = fakeDeps()
  deps.host.startSession = async (request) => {
    const session = deps.agentSessions.get(request.sessionId)
    session.state = 'ended'
    session.exitedBeforeStarted = true
    return { sessionId: request.sessionId, threadId: 'gone', tier: 'unrestricted', effort: 'medium', account: null }
  }
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'already-gone' }, window)
  assert.equal(result.sessionId, 'already-gone', 'the observed start receipt stays truthful')
  assert.equal(deps.calls.filter(call => call.name === 'recordSessionEnd').length, 1)
  assert.deepEqual(deps.calls.find(call => call.name === 'recordSessionEnd').args, ['already-gone', 'exited'])
  assert.equal(deps.agentSessions.has('already-gone'), false, 'the ended start was revived or retained')
})

test('start: failed audit admission crosses IPC as a code without creating a host or session', async () => {
  for (const asynchronous of [false, true]) {
    const fail = () => {
      const error = new Error('private audit key context /private/owner/vault');
      error.code = 'MC_AGENT_RECORD_UNAVAILABLE'
      throw error
    }
    const deps = fakeDeps({ recordSpawnIntent: asynchronous ? async () => fail() : fail })
    const surface = createAgentCommandSurface(deps)
    const rejected = await refusal(surface.run('agent:start', { sessionId: 'audit-refused' }, window))
    assert.equal(rejected.code, 'MC_AGENT_RECORD_UNAVAILABLE')
    assert.equal(rejected.message, 'MC_AGENT_RECORD_UNAVAILABLE')
    const { refusalCode } = await import('../../src/agent-availability-copy.js')
    // Model Electron's property-dropping transport, not a direct error.code read.
    assert.equal(refusalCode(new Error(`Error invoking remote method 'mc-agent:start': Error: ${rejected.message}`)),
      'MC_AGENT_RECORD_UNAVAILABLE')
    assert.equal(deps.agentSessions.size, 0)
    for (const name of ['getAgentHost', 'startSession', 'recordSpawnOutcome', 'bindAgentOwner']) {
      assert.ok(!deps.names().includes(name), `${name} ran after failed audit admission`)
    }
  }
})

test('start: a refused spawn is recorded as refused, leaves no session, and crosses as a renderer-safe code', async () => {
  const deps = fakeDeps()
  deps.host.startSession = async request => { throw fixtureStartRefusal(request.sessionId, 'AGENT_ENGINE_MISSING', 'Unable to run codex: C:\\secret\\engine') }
  const surface = createAgentCommandSurface(deps)
  const refused = await surface.run('agent:start', { sessionId: 'x' }, window)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'AGENT_ENGINE_MISSING')
  assert.equal(refused.reason, 'AGENT_ENGINE_MISSING', 'the reason IS the code; the engine prose stays behind')
  assert.ok(!deps.agentSessions.has('x'))
  const outcome = deps.calls.find(c => c.name === 'recordSpawnOutcome')
  assert.deepEqual([outcome.args[2], outcome.args[3]], ['refused', 'AGENT_ENGINE_MISSING'])
  /* T393: the measured sentence goes to the RECORDER beside the code (the
     recorder decides whether it is safe to keep); it still never crosses to
     the renderer, as asserted on refused.message above. */
  assert.equal(outcome.args[4], 'Unable to run codex: C:\\secret\\engine')

  const cleanup = fakeDeps()
  cleanup.host.startSession = async () => { const e = new Error('x'); e.code = 'AGENT_SESSION_CLEANUP_FAILED'; throw e }
  await refusal(createAgentCommandSurface(cleanup).run('agent:start', { sessionId: 'y' }, window))
  assert.equal(cleanup.agentSessions.get('y').state, 'close-failed', 'a session whose child could not be cleaned up stays in the map, marked')

  const invalidRole = fakeDeps()
  invalidRole.host.startSession = async request => {
    throw fixtureStartRefusal(request.sessionId, 'AGENT_ROLE_BINDING_INVALID', 'authoritative role record contained private hostile detail')
  }
  const invalidRoleSurface = createAgentCommandSurface(invalidRole)
  const roleRefusal = await invalidRoleSurface.run('agent:start', { sessionId: 'bad-role' }, window)
  assert.equal(roleRefusal.ok, false)
  assert.equal(roleRefusal.code, 'AGENT_ROLE_BINDING_INVALID')
  assert.equal(roleRefusal.reason, 'AGENT_ROLE_BINDING_INVALID', 'host role detail crossed the bounded IPC refusal')
  assert.ok(!invalidRole.agentSessions.has('bad-role'))
  const roleOutcome = invalidRole.calls.find(call => call.name === 'recordSpawnOutcome').args
  assert.deepEqual(roleOutcome.slice(2, 4), ['refused', 'AGENT_ROLE_BINDING_INVALID'])
  // T393: the host's sentence reaches the recorder (which keeps or withholds
  // it by shape), and only the recorder; the IPC refusal above carried none.
  assert.equal(roleOutcome[4], 'authoritative role record contained private hostile detail')
})

test('start: a record that cannot be written means no spawn', async () => {
  const deps = fakeDeps({ recordSpawnIntent: () => agentIpcError('MC_AGENT_RECORD_UNAVAILABLE', 'not durable') })
  const surface = createAgentCommandSurface(deps)
  assert.equal((await refusal(surface.run('agent:start', { sessionId: 'z' }, window))).code, 'MC_AGENT_RECORD_UNAVAILABLE')
  assert.ok(!deps.names().includes('startSession'))
  assert.ok(!deps.agentSessions.has('z'))
})

for (const contender of [window, otherWindow]) {
  test(`start: an audit in flight reserves its session id against ${contender === window ? 'the same' : 'another'} owner`, async () => {
    let releaseAudit
    let audits = 0
    const audit = new Promise(resolve => { releaseAudit = resolve })
    const deps = fakeDeps({ recordSpawnIntent: () => {
      audits += 1
      return audits === 1 ? audit : { sequence: audits, eventHash: `hash-${audits}` }
    } })
    const surface = createAgentCommandSurface(deps)
    const first = surface.run('agent:start', { sessionId: 'reserved-start' }, window)
    try {
      const second = await surface.run('agent:start', { sessionId: 'reserved-start' }, contender)
        .then(value => ({ value }), error => ({ error }))
      assert.equal(second.error?.code, 'MC_AGENT_SESSION_EXISTS', 'a second audit passed the session uniqueness gate')
      assert.equal(audits, 1, 'a duplicate start wrote a second intent')
      assert.equal(deps.names().includes('startSession'), false, 'the unresolved first audit must still precede launch')
    } finally {
      releaseAudit({ sequence: 1, eventHash: 'hash-1' })
      await first
    }
    assert.equal(deps.calls.filter(call => call.name === 'startSession').length, 1)
    assert.equal(deps.agentSessions.get('reserved-start').owner, window.owner)
    await surface.run('agent:close', { sessionId: 'reserved-start' }, window)
    assert.equal(deps.agentSessions.has('reserved-start'), false, 'the original owner can still close its child')
  })
}

test('start: a refused audit releases its reserved session id for a retry', async () => {
  let rejectAudit
  const audit = new Promise((_resolve, reject) => { rejectAudit = reject })
  let attempts = 0
  const deps = fakeDeps({ recordSpawnIntent: () => ++attempts === 1
    ? audit : { sequence: 2, eventHash: 'hash-2' } })
  const surface = createAgentCommandSurface(deps)
  const first = surface.run('agent:start', { sessionId: 'retry-audit' }, window)
    .then(value => ({ value }), error => ({ error }))
  rejectAudit(Object.assign(new Error('audit unavailable'), { code: 'MC_AGENT_RECORD_UNAVAILABLE' }))
  assert.equal((await first).error?.code, 'MC_AGENT_RECORD_UNAVAILABLE')
  assert.equal(deps.agentSessions.has('retry-audit'), false)
  assert.equal((await surface.run('agent:start', { sessionId: 'retry-audit' }, window)).sessionId, 'retry-audit')
  assert.equal(deps.calls.filter(call => call.name === 'startSession').length, 1)
})

test('send: owned sessions only, and only picked images ride', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  assert.deepEqual(await surface.run('agent:send', { sessionId: 'chat-1', text: 'hello', model: 'm1' }, window),
    { sessionId: 'chat-1', threadId: 'thread-1', turnId: 'turn-1' })
  /* `origin: 'person'` is the tag the host spools a typed turn under (with
     agent filing on); this command is the one place it is ever said. */
  assert.deepEqual(deps.calls.at(-1).args[0], { sessionId: 'chat-1', text: 'hello', options: { model: 'm1' }, origin: 'person' })

  /* Another owner: the SAME code the window got before the extraction. */
  const foreign = await refusal(surface.run('agent:send', { sessionId: 'chat-1', text: 'hi' }, otherWindow))
  assert.equal(foreign.code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.equal(foreign.message, 'MC_AGENT_UNKNOWN_SESSION', 'renderer-safe: the sessionId prose stays behind')
  assert.equal((await refusal(surface.run('agent:send', { sessionId: 'nope', text: 'hi' }, window))).code, 'MC_AGENT_UNKNOWN_SESSION')

  /* THE IMAGE FENCE. Unpicked refuses by name and nothing is sent. */
  deps.calls.length = 0
  const unpicked = await refusal(surface.run('agent:send', { sessionId: 'chat-1', text: 'look', images: [{ path: 'C:\\anything.png' }] }, window))
  assert.equal(unpicked.code, 'MC_AGENT_ATTACHMENT_UNKNOWN')
  assert.ok(!deps.names().includes('sendTurn'), 'an unpicked image reached the engine')

  /* Picked in THIS session by THIS owner's dialog: rides. */
  await surface.run('agent:pick-attachment', { sessionId: 'chat-1' }, window)
  deps.calls.length = 0
  await surface.run('agent:send', { sessionId: 'chat-1', text: 'look', images: [{ path: 'C:\\fake\\picked.png' }] }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { sessionId: 'chat-1', text: 'look', images: [{ path: 'C:\\fake\\picked.png' }], origin: 'person' })

  /* Picked in ANOTHER session: refused -- the allowlist is per session. */
  await startedSession(deps, surface, 'chat-2')
  assert.equal((await refusal(surface.run('agent:send', { sessionId: 'chat-2', text: 'look', images: [{ path: 'C:\\fake\\picked.png' }] }, window))).code, 'MC_AGENT_ATTACHMENT_UNKNOWN')
})

test('tree adoption preserves the exact session owner and only records an acknowledged first assignment', async () => {
  const bindings = []
  const deps = fakeDeps({ recordTranscriptBinding: async value => { bindings.push(value) } })
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  const owned = deps.agentSessions.get('chat-1')
  const request = { sessionId: 'chat-1', selfName: 'Worker', managerName: 'Controller', treeKey: 'root-1',
    requestKeys: { treeAnchors: ['root-1', 'node-1'], threadId: 'node-1' } }
  assert.equal(owned.treeNodeId, null)
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:tree-adopt', request, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.equal((await refusal(surface.run('agent:tree-adopt', { ...request, sessionId: 'missing' }, window))).code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.equal((await refusal(surface.run('agent:tree-adopt', { ...request, credential: 'forged' }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
  assert.equal((await refusal(surface.run('agent:tree-adopt', { ...request, selfName: 'x'.repeat(121) }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
  assert.equal(deps.calls.length, 0, 'refused ownership and payloads reach no host mutation')
  const adopt = deps.host.adoptTreeAddress
  deps.host.adoptTreeAddress = () => { throw Object.assign(new Error('directory refused'), { code: 'TREE_DIRECTORY_BUSY' }) }
  await assert.rejects(surface.run('agent:tree-adopt', request, window), { code: 'TREE_DIRECTORY_BUSY' })
  assert.equal(owned.treeNodeId, null)
  assert.deepEqual(bindings, [])
  for (const result of [null, undefined, { ok: false }]) {
    deps.host.adoptTreeAddress = () => result
    assert.deepEqual(await surface.run('agent:tree-adopt', request, window), result)
    assert.equal(owned.treeNodeId, null, 'missing or negative acknowledgment cannot establish saved identity')
    assert.deepEqual(bindings, [])
  }
  deps.host.adoptTreeAddress = adopt
  assert.deepEqual(await surface.run('agent:tree-adopt', request, window), { ok: true, ...request })
  assert.equal(deps.agentSessions.get('chat-1'), owned, 'adoption must keep the record that owns callbacks and lifecycle state')
  assert.equal(owned.owner, WINDOW_OWNER)
  assert.equal(owned.treeNodeId, 'node-1')
  assert.throws(() => { owned.treeNodeId = 'forged-node' }, TypeError)
  assert.deepEqual(bindings, [{ sessionId: 'chat-1', nodeId: 'node-1', treeId: 'root-1' }])
  assert.deepEqual(deps.calls.map(call => call.name), ['adoptTreeAddress'], 'adoption starts and sends nothing')
})

test('tree-address rebinds only an owned running session with bounded names and tree key', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  const request = {
    sessionId: 'chat-1',
    selfName: 'Worker',
    managerName: 'Controller',
    treeKey: 'tree-main',
  }

  assert.deepEqual(await surface.run('agent:tree-address', request, window), { ok: true, ...request })
  assert.deepEqual(deps.calls.at(-1), { name: 'updateTreeAddress', args: [request] })
  const withAncestry = { ...request, requestKeys: { treeAnchors: ['tree-main', 'worker-node'], threadId: 'worker-node' } }
  await surface.run('agent:tree-address', withAncestry, window)
  assert.deepEqual(deps.calls.at(-1), { name: 'updateTreeAddress', args: [withAncestry] })
  assert.equal(
    (await refusal(surface.run('agent:tree-address', request, otherWindow))).code,
    'MC_AGENT_UNKNOWN_SESSION',
    'another window could rewrite this circle\'s routing address',
  )
  assert.equal(
    (await refusal(surface.run('agent:tree-address', { ...request, extra: true }, window))).code,
    'MC_AGENT_INVALID_PAYLOAD',
  )
  assert.equal(
    (await refusal(surface.run('agent:tree-address', { ...request, selfName: 'x'.repeat(121) }, window))).code,
    'MC_AGENT_INVALID_PAYLOAD',
  )
})

/* THE DEFECT THIS PINS. `session.tier`, set once at start two lines into
 * 'agent:start' above, is the ONLY thing that labels every row this app signs
 * into agent-turn-usage-records.jsonl for the life of a session (shell/main.cjs
 * noteAgentTurnUsage -> usageLabel('tier', session.tier)). "Switch model"
 * (src/fleet-tree-copy.js MODEL_PANEL) sends a real, STICKY per-turn override
 * that the host actually applies -- "Messages run on X until you change it
 * back" -- and until 'agent:send' read the host's answer back, nothing moved
 * this session's own tier to match, so every turn after a switch signed into
 * that ledger under the tier the session merely started on. shell/agent-
 * host.cjs sendTurn() now resolves `tier` on its result whenever a requested
 * model override actually validated (tierForModel()); this is the one place
 * that answer may be applied, and it is a real dependency return, not a guess
 * from the request the caller sent. */
test('send: a model switch that actually lands moves the session tier the usage ledger reads', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'chat-1', tier: 'luna' }, window)
  deps.calls.length = 0
  assert.equal(deps.agentSessions.get('chat-1').tier, 'luna', 'the session starts on the tier it was asked for')

  /* The shape shell/agent-host.cjs's REAL sendTurn() now resolves once a
     requested model validates against a real, launchable, same-provider tier
     -- see tools/test/session-reply-paths.test.mjs for that resolution itself. */
  deps.host.sendTurn = async (request) => { deps.calls.push({ name: 'sendTurn', args: [request] }); return { sessionId: request.sessionId, threadId: 'thread-1', turnId: 'turn-2', tier: 'sol' } }
  await surface.run('agent:send', { sessionId: 'chat-1', text: 'switch to sol', model: 'gpt-5.6-sol' }, window)

  assert.equal(deps.agentSessions.get('chat-1').tier, 'sol',
    'a landed model switch must move the session tier -- otherwise every later turn signs its usage under the wrong one, permanently')
})

test('send: a turn with no model override leaves the session tier exactly as it was', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'chat-1', tier: 'luna' }, window)
  deps.calls.length = 0
  await surface.run('agent:send', { sessionId: 'chat-1', text: 'no switch here' }, window)
  assert.equal(deps.agentSessions.get('chat-1').tier, 'luna', 'a plain send must never disturb the session tier')
})

test('request files through the host; requests reads the ledger without a host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  const filed = await surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'do this' }, window)
  assert.deepEqual(filed, { ok: true, id: 'r-1', scope: 'tree', key: 'k1', words: 'do this', label: null })
  assert.deepEqual(deps.names(), ['getAgentHost', 'fileStandingRequest'])
  await surface.run('agent:request', { scope: 'tree', words: 'no key' }, window)
  assert.equal(deps.calls.at(-1).args[0].key, null)
  assert.equal((await refusal(surface.run('agent:request', { scope: 'tree', words: 'x'.repeat(16 * 1024 + 1) }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')

  /* THE LABEL (one canonical ledger, 2026-09-02): the human name of what the
     key addresses, snapshotted onto the record so the Ledger page can say
     "Manager 2". Optional, bounded at the store's own 120, and it reaches the
     host beside the key. */
  await surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', label: 'Manager 2' }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { scope: 'tree', key: 'k1', words: 'w', label: 'Manager 2' })
  await surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', label: 'x'.repeat(120) }, window)
  assert.equal(deps.calls.at(-1).args[0].label.length, 120, 'a label at the bound is accepted')
  assert.equal((await refusal(surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', label: 'x'.repeat(121) }, window))).code, 'MC_AGENT_INVALID_PAYLOAD', 'a label over the bound refuses')
  assert.equal((await refusal(surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', label: 7 }, window))).code, 'MC_AGENT_INVALID_PAYLOAD', 'a label that is not text refuses')

  deps.calls.length = 0
  assert.deepEqual(await surface.run('agent:requests', { scope: 'tree', key: 'k1' }, window), { ok: true, exists: false, entries: [] })
  assert.deepEqual(deps.names(), ['readStandingRequests'])
  assert.deepEqual(deps.calls[0].args[0], { scope: 'tree', key: 'k1' })
  assert.equal((await refusal(surface.run('agent:requests', undefined, window))).code, 'MC_AGENT_INVALID_PAYLOAD', 'scope is required')
})

/* THE LEDGER KINDS SPLIT (Controller 3's shared interface, 2026-09-07): a
   /Task or /Ask files through this exact same agent:request channel, with an
   OPTIONAL `kind` field ('T' or 'A') riding beside scope, key, words and
   label. Before this field existed on the allowlist, agentPayload() refused
   ANY unexpected key by name (MC_AGENT_INVALID_PAYLOAD) -- so a task or an
   ask sent from the renderer would have refused outright, never merely
   filed as an ordinary rule. */


test('request difficulty crosses the surface and actual host into the store argument unchanged', async () => {
  const { createAgentHost } = require('../../shell/agent-host.cjs')
  const workdir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mc-request-difficulty-chain-')))
  const received = []
  const host = createAgentHost({
    enginePath: path.join(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js'),
    defaultCwd: workdir,
    rLedgerLoader: () => ({ fileRequest: input => {
      received.push(input)
      return { id: 'T1', scope: input.scope, key: input.key, status: 'open' }
    } }),
  })
  try {
    const surface = createAgentCommandSurface(fakeDeps({ getAgentHost: async () => host }))
    for (const difficulty of ['easy', 'medium', 'hard']) {
      const reply = await surface.run('agent:request', { scope: 'global', words: 'Keep exact task words.', kind: 'T', difficulty }, window)
      assert.equal(reply.ok, true)
      assert.equal(reply.id, 'T1')
      assert.deepEqual(received.at(-1), { scope: 'global', key: null, words: 'Keep exact task words.', scopeLabel: null, kind: 'T', difficulty })
    }
  } finally {
    await host.closeAll()
  }
})

test('request forwards only explicit canonical task difficulty before invoking the real host seam', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  for (const difficulty of ['easy', 'medium', 'hard']) {
    await surface.run('agent:request', { scope: 'global', words: 'Graded task.', kind: 'T', difficulty }, window)
    assert.deepEqual(deps.calls.at(-1).args[0],
      { scope: 'global', key: null, words: 'Graded task.', label: null, kind: 'T', difficulty })
  }
  await surface.run('agent:request', { scope: 'global', words: 'Legacy task.', kind: 'T' }, window)
  assert.equal(Object.hasOwn(deps.calls.at(-1).args[0], 'difficulty'), false)
  const before = deps.calls.length
  for (const input of [
    { kind: 'T', difficulty: null }, { kind: 'T', difficulty: '' },
    { kind: 'T', difficulty: 'Hard' }, { kind: 'T', difficulty: 2 },
    { kind: 'T', difficulty: ['easy'] }, { kind: 'A', difficulty: 'easy' },
    { difficulty: 'easy' }, { kind: 'T', failedReviewCount: 2 },
    { kind: 'T', gradingEnabled: true },
  ]) {
    assert.equal((await refusal(surface.run('agent:request', { scope: 'global', words: 'Retained task.', ...input }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
  }
  assert.equal(deps.calls.length, before, 'invalid grade or renderer policy must not reach the host')
})

test('request: an optional kind of T or A rides to the host; an unrecognized kind refuses by name', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)

  await surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'Rotate the staging credentials.', kind: 'T' }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { scope: 'tree', key: 'k1', words: 'Rotate the staging credentials.', label: null, kind: 'T' },
    'a task filing must carry kind T to the host beside the untouched scope, key, words and label')

  await surface.run('agent:request', { scope: 'thread', key: 'k1', words: 'Which cloud account should this use?', kind: 'A' }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { scope: 'thread', key: 'k1', words: 'Which cloud account should this use?', label: null, kind: 'A' },
    'an ask filing must carry kind A to the host beside the untouched scope, key, words and label')

  /* A plain /Request -- no kind at all -- must still reach the host as
     exactly the four keys the existing test above already pins; this is the
     "byte-for-byte unchanged" half of the contract, proved again here
     alongside the new field so the two never drift apart. */
  await surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w' }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { scope: 'tree', key: 'k1', words: 'w', label: null },
    'a plain request must never carry a kind key at all')

  assert.equal((await refusal(surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', kind: 'R' }, window))).code,
    'MC_AGENT_INVALID_PAYLOAD', 'this channel never files kind R explicitly -- a plain request sends no kind field')
  assert.equal((await refusal(surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', kind: 'not-a-kind' }, window))).code,
    'MC_AGENT_INVALID_PAYLOAD', 'an unrecognized kind value must refuse rather than reach the host')
  assert.equal((await refusal(surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w', kind: 7 }, window))).code,
    'MC_AGENT_INVALID_PAYLOAD', 'a kind that is not text must refuse rather than reach the host')
})

/* THE WHOLE LEDGER FOR THE LEDGER PAGE (owner, 2026-09-02: one canonical
   ledger with scope tiers). A READ: no host, no session, the reader's own
   answer passed through, and a read-only caller served -- because the reader
   never creates the file, a read is all it is. */
test('ledger reads the whole ledger without a host, bounded, and serves a read-only caller', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal(surface.isWrite('agent:ledger'), false, 'a read that wrote would be reachable by a read-only relay')
  assert.equal(surface.needsDialog('agent:ledger'), false)

  const all = await surface.run('agent:ledger', {}, window)
  assert.equal(all.ok, true)
  assert.deepEqual(deps.names(), ['readCanonicalLedger'], 'the ledger is read through the reader and nothing else')
  assert.deepEqual(deps.calls[0].args[0], { scope: 'all', key: null, removed: false }, 'an empty ask is every tier, live records only')

  deps.calls.length = 0
  await surface.run('agent:ledger', { scope: 'tree', key: 'node-1', removed: true }, window)
  assert.deepEqual(deps.calls[0].args[0], { scope: 'tree', key: 'node-1', removed: true })
  deps.calls.length = 0
  await surface.run('agent:ledger', { scope: 'session', removed: 'true' }, window)
  assert.deepEqual(deps.calls[0].args[0], { scope: 'session', key: null, removed: true }, 'the facade\'s string true reads as the boolean')
  deps.calls.length = 0
  await surface.run('agent:ledger', { removed: 'false' }, window)
  assert.deepEqual(deps.calls[0].args[0], { scope: 'all', key: null, removed: false })

  /* The reader's own refusal passes through as data, never as a throw. */
  const refusing = createAgentCommandSurface(fakeDeps({ readCanonicalLedger: () => ({ ok: false, code: 'AGENT_LEDGER_SCOPE_INVALID', reason: 'Choose a tier.', records: [] }) }))
  assert.deepEqual(await refusing.run('agent:ledger', { scope: 'nope' }, window), { ok: false, code: 'AGENT_LEDGER_SCOPE_INVALID', reason: 'Choose a tier.', records: [] })

  /* Bounds: unknown fields, an over-long scope or key, a removed that is not
     a boolean word, and no payload at all refuse before the reader is asked. */
  for (const payload of [
    undefined,
    null,
    { scope: 'tree', path: 'C:\\anywhere' },
    { scope: 'x'.repeat(17) },
    { key: 'k'.repeat(129) },
    { removed: 'yes' },
    { removed: 1 },
    { scope: '' },
  ]) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run('agent:ledger', payload, window))).code, 'MC_AGENT_INVALID_PAYLOAD', JSON.stringify(payload))
    assert.deepEqual(deps.names(), [], `${JSON.stringify(payload)} reached the reader`)
  }

  /* A read-only caller is answered exactly as the window is. */
  deps.calls.length = 0
  const asReadOnly = await surface.run('agent:ledger', { scope: 'thread', key: 'node-7' }, readOnly)
  assert.equal(asReadOnly.ok, true)
  assert.deepEqual(deps.calls[0].args[0], { scope: 'thread', key: 'node-7', removed: false })
  for (const forbidden of ['getAgentHost', 'startSession', 'fileStandingRequest']) {
    assert.ok(!deps.names().includes(forbidden), `a ledger read touched ${forbidden}`)
  }
})

/* THE PERSON'S DECISION ON ONE RECORD (owner, 2026-09-02): approve a proposal
   an agent filed, or decline it. A write, person-only exactly like edit and
   remove, through the built host; one of two decision words; an optional
   bounded reason. */
test('request-decide: a person-only write with two decision words, through the built host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal(surface.isWrite('agent:request-decide'), true)
  assert.equal(surface.needsDialog('agent:request-decide'), false)

  const approved = await surface.run('agent:request-decide', { id: 'R5', decision: 'approve' }, window)
  assert.deepEqual(approved, { ok: true, id: 'R5', status: 'open' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'decideStandingRequest'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'R5', decision: 'approve', reason: null }, 'a missing reason crosses as null')
  deps.calls.length = 0
  const declined = await surface.run('agent:request-decide', { id: 'R5.1', decision: 'decline', reason: 'Not this one.' }, window)
  assert.deepEqual(declined, { ok: true, id: 'R5.1', status: 'declined' })
  assert.deepEqual(deps.calls.at(-1).args[0], { id: 'R5.1', decision: 'decline', reason: 'Not this one.' })
  deps.calls.length = 0
  await surface.run('agent:request-decide', { id: 'R5', decision: 'approve', reason: '' }, window)
  assert.equal(deps.calls.at(-1).args[0].reason, null, 'an empty reason is no reason')

  for (const payload of [
    undefined,
    {},
    { id: 'R5' },
    { decision: 'approve' },
    { id: 'R5', decision: 'maybe' },
    { id: 'R5', decision: 'approve', words: 'w' },
    { id: 'x'.repeat(65), decision: 'approve' },
    { id: 'R5', decision: 'approve', reason: 'x'.repeat(2049) },
    { id: 'R5', decision: 7 },
  ]) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run('agent:request-decide', payload, window))).code, 'MC_AGENT_INVALID_PAYLOAD', JSON.stringify(payload))
    assert.deepEqual(deps.names(), [], `${JSON.stringify(payload)} touched the host`)
  }

  /* The host's own refusal crosses as its code, never its prose. */
  deps.host.decideStandingRequest = async () => { const e = new Error('R9 is not in the ledger (C:\\secret\\ledger.json)'); e.code = 'AGENT_REQUEST_ENTRY_UNKNOWN'; throw e }
  const unknown = await refusal(surface.run('agent:request-decide', { id: 'R9', decision: 'approve' }, window))
  assert.equal(unknown.code, 'AGENT_REQUEST_ENTRY_UNKNOWN')
  assert.equal(unknown.message, 'AGENT_REQUEST_ENTRY_UNKNOWN', 'the prose (and the path in it) stays behind')

  /* PERSON-ONLY, the same three answers the rewrite verbs give. */
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:request-decide', { id: 'R5', decision: 'approve' }, readOnly))).code, READ_ONLY_REFUSAL)
  assert.deepEqual(deps.names(), [])
  const relay = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: true, label: 'web (relay)' })
  const relayReadOnly = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: false, label: 'web (relay)' })
  deps.host.decideStandingRequest = async (request) => ({ ok: true, id: request.id, status: 'open' })
  assert.deepEqual(await surface.run('agent:request-decide', { id: 'R5', decision: 'approve' }, relay), { ok: true, id: 'R5', status: 'open' })
  assert.equal((await refusal(surface.run('agent:request-decide', { id: 'R5', decision: 'approve' }, relayReadOnly))).code, READ_ONLY_REFUSAL)
  deps.calls.length = 0
  const refused = await refusal(surface.run('agent:request-decide', { id: 'R5', decision: 'approve' }, elsewhere))
  assert.equal(refused.code, PRINCIPAL_REFUSAL, 'a principal that is neither the window nor the relay decided a record')
  assert.equal(refused.message, PRINCIPAL_REFUSAL)
  assert.equal((await refusal(surface.run('agent:request-decide', {}, elsewhere))).code, PRINCIPAL_REFUSAL, 'the person-only gate comes before the payload is read')
  assert.deepEqual(deps.names(), [], 'a person-only refusal touched the host')
})

/* THE PERSON'S RESOLUTION OF ONE STANDING REQUEST (R_LEDGER kinds follow-on,
   2026-09-07, Controller 3 L4e). The exact mirror of request-decide just
   above: a write, person-only, through the built host; a bounded id, a
   bounded status word, an optional bounded reason. The id's kind letter and
   the status vocabulary are the host's job, not this seam's -- this test
   proves only the bounds and the fences, the same split request-decide's
   test proves for decision words. */
test('request-resolve: a person-only write with a bounded status word, through the built host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal(surface.isWrite('agent:request-resolve'), true)
  assert.equal(surface.needsDialog('agent:request-resolve'), false)

  const resolved = await surface.run('agent:request-resolve', { id: 'R5', status: 'done' }, window)
  assert.deepEqual(resolved, { ok: true, id: 'R5', status: 'done' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'resolveStandingRequest'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'R5', status: 'done', reason: null }, 'a missing reason crosses as null')
  deps.calls.length = 0
  const withReason = await surface.run('agent:request-resolve', { id: 'R5.1', status: 'not-possible-as-asked', reason: 'Cannot reach that account.' }, window)
  assert.deepEqual(withReason, { ok: true, id: 'R5.1', status: 'not-possible-as-asked' })
  assert.deepEqual(deps.calls.at(-1).args[0], { id: 'R5.1', status: 'not-possible-as-asked', reason: 'Cannot reach that account.' })
  deps.calls.length = 0
  await surface.run('agent:request-resolve', { id: 'R5', status: 'done', reason: '' }, window)
  assert.equal(deps.calls.at(-1).args[0].reason, null, 'an empty reason is no reason')

  for (const payload of [
    undefined,
    {},
    { id: 'R5' },
    { status: 'done' },
    { id: 'R5', status: 'done', decision: 'approve' },
    { id: 'x'.repeat(65), status: 'done' },
    { id: 'R5', status: 'x'.repeat(33) },
    { id: 'R5', status: 'done', reason: 'x'.repeat(2049) },
    { id: 'R5', status: 7 },
  ]) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run('agent:request-resolve', payload, window))).code, 'MC_AGENT_INVALID_PAYLOAD', JSON.stringify(payload))
    assert.deepEqual(deps.names(), [], `${JSON.stringify(payload)} touched the host`)
  }

  /* The host's own refusal crosses as its code, never its prose -- the same
     posture as decide (a re-prefixed R_LEDGER_* code) and as completeTask
     etc (the store's own code passed through unchanged): either way this
     seam never invents or rewrites the code, only forwards it. */
  deps.host.resolveStandingRequest = async () => { const e = new Error('T9 is not a standing request record (C:\\secret\\ledger.json)'); e.code = 'AGENT_LEDGER_ID_KIND_MISMATCH'; throw e }
  const unknown = await refusal(surface.run('agent:request-resolve', { id: 'T9', status: 'done' }, window))
  assert.equal(unknown.code, 'AGENT_LEDGER_ID_KIND_MISMATCH')
  assert.equal(unknown.message, 'AGENT_LEDGER_ID_KIND_MISMATCH', 'the prose (and the path in it) stays behind')

  /* PERSON-ONLY, the same three answers decide gives. */
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:request-resolve', { id: 'R5', status: 'done' }, readOnly))).code, READ_ONLY_REFUSAL)
  assert.deepEqual(deps.names(), [])
  const relay = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: true, label: 'web (relay)' })
  const relayReadOnly = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: false, label: 'web (relay)' })
  deps.host.resolveStandingRequest = async (request) => ({ ok: true, id: request.id, status: request.status })
  assert.deepEqual(await surface.run('agent:request-resolve', { id: 'R5', status: 'done' }, relay), { ok: true, id: 'R5', status: 'done' })
  assert.equal((await refusal(surface.run('agent:request-resolve', { id: 'R5', status: 'done' }, relayReadOnly))).code, READ_ONLY_REFUSAL)
  deps.calls.length = 0
  const refused = await refusal(surface.run('agent:request-resolve', { id: 'R5', status: 'done' }, elsewhere))
  assert.equal(refused.code, PRINCIPAL_REFUSAL, 'a principal that is neither the window nor the relay resolved a record')
  assert.equal(refused.message, PRINCIPAL_REFUSAL)
  assert.equal((await refusal(surface.run('agent:request-resolve', {}, elsewhere))).code, PRINCIPAL_REFUSAL, 'the person-only gate comes before the payload is read')
  assert.deepEqual(deps.names(), [], 'a person-only refusal touched the host')
})

/* THE PERSON'S HAND ON ONE STANDING RULE (O7 improvements, owner 2026-08-22:
   "its a hand edit tool. for the user to go in on the toolsenabled ledger and
   hand edit or delete them"). Two verbs, registered as writes without a
   dialog; the same bounds as filing (id, optional key, and for an edit the
   words at the ledger's 16KB cap); the host is BUILT for them like a filing
   is, because no session need exist. And PERSON-ONLY: the window and the
   relay (the person's two seats) may call them -- the relay only with its
   write consent, which run()'s read-only gate checks first -- and any other
   principal kind is refused by name before the payload is read. */
test('request-edit and request-remove: person-only writes, bounded like filing, through the built host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal(surface.isWrite('agent:request-edit'), true)
  assert.equal(surface.isWrite('agent:request-remove'), true)
  assert.equal(surface.needsDialog('agent:request-edit'), false)
  assert.equal(surface.needsDialog('agent:request-remove'), false)

  const edited = await surface.run('agent:request-edit', { id: 'RT1', key: 'k1', words: 'new words' }, window)
  assert.deepEqual(edited, { ok: true, id: 'RT1', scope: 'tree', key: 'k1' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'editStandingRequest'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'RT1', key: 'k1', words: 'new words' })
  deps.calls.length = 0
  await surface.run('agent:request-edit', { id: 'R2000', words: 'global words' }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { id: 'R2000', key: null, words: 'global words' }, 'a missing key crosses as null, as it does for filing')

  deps.calls.length = 0
  const removed = await surface.run('agent:request-remove', { id: 'RT1', key: 'k1' }, window)
  assert.deepEqual(removed, { ok: true, id: 'RT1', scope: 'tree', key: 'k1', removed: ['RT1'] })
  assert.deepEqual(deps.names(), ['getAgentHost', 'removeStandingRequest'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'RT1', key: 'k1' })
  deps.calls.length = 0
  await surface.run('agent:request-remove', { id: 'R2000' }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { id: 'R2000', key: null })

  /* The args shape: unknown fields, a missing id, over-long words, and a
     key or id out of bounds all refuse before the host is touched. */
  for (const [command, payload] of [
    ['agent:request-edit', { id: 'RT1', words: 'w', scope: 'tree' }],
    ['agent:request-edit', { key: 'k1', words: 'w' }],
    ['agent:request-edit', { id: 'RT1', key: 'k1' }],
    ['agent:request-edit', { id: 'RT1', words: '' }],
    ['agent:request-edit', { id: 'RT1', words: 'x'.repeat(16 * 1024 + 1) }],
    ['agent:request-edit', { id: 'x'.repeat(65), words: 'w' }],
    ['agent:request-edit', { id: 'RT1', key: 'k'.repeat(129), words: 'w' }],
    ['agent:request-remove', { id: 'RT1', words: 'w' }],
    ['agent:request-remove', { key: 'k1' }],
    ['agent:request-remove', {}],
    ['agent:request-remove', undefined],
  ]) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run(command, payload, window))).code, 'MC_AGENT_INVALID_PAYLOAD', `${command} ${JSON.stringify(payload)}`)
    assert.deepEqual(deps.names(), [], `${command} touched the host with a bad payload`)
  }

  /* The host's own refusal crosses as its code, never its prose. */
  deps.host.editStandingRequest = async () => { const e = new Error('RT9 is not in this ledger (C:\\secret\\ledger.md)'); e.code = 'AGENT_REQUEST_ENTRY_UNKNOWN'; throw e }
  const unknown = await refusal(surface.run('agent:request-edit', { id: 'RT9', key: 'k1', words: 'w' }, window))
  assert.equal(unknown.code, 'AGENT_REQUEST_ENTRY_UNKNOWN')
  assert.equal(unknown.message, 'AGENT_REQUEST_ENTRY_UNKNOWN', 'the prose (and the path in it) stays behind')

  /* PERSON-ONLY. A read-only caller meets the read-only gate first, as for
     filing; a relay WITH write consent is the signed-in person and is
     served; any principal whose kind is neither window nor relay is refused
     by name, and nothing is touched. */
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:request-edit', { id: 'RT1', key: 'k1', words: 'w' }, readOnly))).code, READ_ONLY_REFUSAL)
  assert.equal((await refusal(surface.run('agent:request-remove', { id: 'RT1', key: 'k1' }, readOnly))).code, READ_ONLY_REFUSAL)
  assert.deepEqual(deps.names(), [])
  const relay = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: true, label: 'web (relay)' })
  const relayReadOnly = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: false, label: 'web (relay)' })
  deps.host.editStandingRequest = async (request) => ({ ok: true, id: request.id, scope: 'tree', key: request.key })
  assert.deepEqual(await surface.run('agent:request-edit', { id: 'RT1', key: 'k1', words: 'w' }, relay), { ok: true, id: 'RT1', scope: 'tree', key: 'k1' })
  assert.deepEqual(await surface.run('agent:request-remove', { id: 'RT1', key: 'k1' }, relay), { ok: true, id: 'RT1', scope: 'tree', key: 'k1', removed: ['RT1'] })
  assert.equal((await refusal(surface.run('agent:request-edit', { id: 'RT1', key: 'k1', words: 'w' }, relayReadOnly))).code, READ_ONLY_REFUSAL, 'a relay without web-drive consent must be refused')
  deps.calls.length = 0
  for (const command of ['agent:request-edit', 'agent:request-remove']) {
    /* The code is the surface's own "not a principal I can reason about"
       (PRINCIPAL_REFUSAL, already in the refusal vocabulary); the sentence
       is this fence's own, so a log reader knows WHICH gate held it. */
    const refused = await refusal(surface.run(command, { id: 'RT1', key: 'k1', ...(command === 'agent:request-edit' ? { words: 'w' } : {}) }, elsewhere))
    assert.equal(refused.code, PRINCIPAL_REFUSAL, `${command} served a principal that is neither the window nor the relay`)
    assert.equal(refused.message, PRINCIPAL_REFUSAL, 'renderer-safe: the sentence stays behind, the code crosses')

    const malformed = await refusal(surface.run(command, {}, elsewhere))
    assert.equal(malformed.code, PRINCIPAL_REFUSAL, `${command} read a malformed payload before applying its person-only gate`)
  }
  assert.deepEqual(deps.names(), [], 'a person-only refusal touched the host')
  /* And the other kind still files and reads as before -- the fence is on
     the two rewrite verbs alone. */
  await surface.run('agent:request', { scope: 'tree', key: 'k1', words: 'w' }, elsewhere)
  assert.ok(deps.names().includes('fileStandingRequest'))
})

/* THE LEDGER PAGE'S WRITE VERBS FOR TASK AND ASK RECORDS (ledger kinds,
   2026-09-07, Controller 3 ruling 05:20Z). The exact mirror of the block
   just above: writes, no dialog, person-only, bounded ids, and for
   answerAsk the words at the same 16KB cap as filing. */
test('task-complete, task-remove, ask-answer, ask-decline, ask-remove: person-only writes through the built host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  for (const command of ['agent:task-complete', 'agent:task-remove', 'agent:ask-answer', 'agent:ask-decline', 'agent:ask-remove']) {
    assert.equal(surface.isWrite(command), true, command)
    assert.equal(surface.needsDialog(command), false, command)
  }

  const completed = await surface.run('agent:task-complete', { id: 'T1' }, window)
  assert.deepEqual(completed, { ok: true, id: 'T1', status: 'done' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'completeTask'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'T1' })

  deps.calls.length = 0
  const removed = await surface.run('agent:task-remove', { id: 'T1' }, window)
  assert.deepEqual(removed, { ok: true, id: 'T1', status: 'removed' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'removeTask'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'T1' })

  deps.calls.length = 0
  const answered = await surface.run('agent:ask-answer', { id: 'A1', words: 'the answer' }, window)
  assert.deepEqual(answered, { ok: true, id: 'A1', status: 'answered' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'answerAsk'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'A1', words: 'the answer' })

  deps.calls.length = 0
  const declined = await surface.run('agent:ask-decline', { id: 'A1' }, window)
  assert.deepEqual(declined, { ok: true, id: 'A1', status: 'declined' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'declineAsk'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'A1', reason: null })

  deps.calls.length = 0
  await surface.run('agent:ask-decline', { id: 'A2', reason: 'The owner gave a reason.' }, window)
  assert.deepEqual(deps.calls[1].args[0], { id: 'A2', reason: 'The owner gave a reason.' })

  deps.calls.length = 0
  const removedAsk = await surface.run('agent:ask-remove', { id: 'A1' }, window)
  assert.deepEqual(removedAsk, { ok: true, id: 'A1', status: 'removed' })
  assert.deepEqual(deps.names(), ['getAgentHost', 'removeAsk'])
  assert.deepEqual(deps.calls[1].args[0], { id: 'A1' })

  /* Bad shape refuses before the host is touched: unknown fields, a missing
     id, an id or words out of bounds, and answerAsk with no words at all. */
  for (const [command, payload] of [
    ['agent:task-complete', { id: 'T1', words: 'w' }],
    ['agent:task-complete', {}],
    ['agent:task-complete', undefined],
    ['agent:task-complete', { id: 'x'.repeat(65) }],
    ['agent:task-remove', { id: 'T1', reason: 'r' }],
    ['agent:task-remove', {}],
    ['agent:ask-answer', { id: 'A1' }],
    ['agent:ask-answer', { id: 'A1', words: '' }],
    ['agent:ask-answer', { id: 'A1', words: 'x'.repeat(16 * 1024 + 1) }],
    ['agent:ask-answer', { id: 'A1', words: 'w', reason: 'r' }],
    ['agent:ask-decline', { id: 'A1', reason: 'r'.repeat(2049) }],
    ['agent:ask-decline', { id: 'A1', reason: false }],
    ['agent:ask-decline', { id: 'A1', reason: 'bad\0reason' }],
    ['agent:ask-decline', { id: 'A1', words: 'an unknown field' }],
    ['agent:ask-decline', {}],
    ['agent:ask-remove', { id: 'A1', words: 'w' }],
    ['agent:ask-remove', {}],
  ]) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run(command, payload, window))).code, 'MC_AGENT_INVALID_PAYLOAD', `${command} ${JSON.stringify(payload)}`)
    assert.deepEqual(deps.names(), [], `${command} touched the host with a bad payload`)
  }

  /* The store's own refusal crosses as its code, never its prose -- see the
     interface ruling: "the store's typed refusal codes pass through
     unchanged" (unlike the R family's re-prefix). */
  deps.host.completeTask = async () => { const e = new Error('T9 is done (C:\\secret\\ledger.md)'); e.code = 'AGENT_LEDGER_ID_KIND_MISMATCH'; throw e }
  const unknown = await refusal(surface.run('agent:task-complete', { id: 'T9' }, window))
  assert.equal(unknown.code, 'AGENT_LEDGER_ID_KIND_MISMATCH')
  assert.equal(unknown.message, 'AGENT_LEDGER_ID_KIND_MISMATCH', 'the prose (and the path in it) stays behind')

  /* PERSON-ONLY, same fence as request-edit/request-remove/request-decide. */
  deps.calls.length = 0
  for (const command of ['agent:task-complete', 'agent:task-remove', 'agent:ask-answer', 'agent:ask-decline', 'agent:ask-remove']) {
    assert.equal((await refusal(surface.run(command, { id: 'T1' }, readOnly))).code, READ_ONLY_REFUSAL, command)
  }
  assert.deepEqual(deps.names(), [])
  const relay = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: true, label: 'web (relay)' })
  const relayReadOnly = Object.freeze({ kind: 'relay', owner: { principal: 'relay' }, mayWrite: false, label: 'web (relay)' })
  deps.host.completeTask = async (request) => ({ ok: true, id: request.id, status: 'done' })
  assert.deepEqual(await surface.run('agent:task-complete', { id: 'T1' }, relay), { ok: true, id: 'T1', status: 'done' })
  assert.equal((await refusal(surface.run('agent:task-complete', { id: 'T1' }, relayReadOnly))).code, READ_ONLY_REFUSAL, 'a relay without web-drive consent must be refused')

  deps.calls.length = 0
  for (const command of ['agent:task-complete', 'agent:task-remove', 'agent:ask-answer', 'agent:ask-decline', 'agent:ask-remove']) {
    const payload = command === 'agent:ask-answer' ? { id: 'A1', words: 'w' } : { id: 'T1' }
    const refused = await refusal(surface.run(command, payload, elsewhere))
    assert.equal(refused.code, PRINCIPAL_REFUSAL, `${command} served a principal that is neither the window nor the relay`)
    assert.equal(refused.message, PRINCIPAL_REFUSAL, 'renderer-safe: the sentence stays behind, the code crosses')

    const malformed = await refusal(surface.run(command, {}, elsewhere))
    assert.equal(malformed.code, PRINCIPAL_REFUSAL, `${command} read a malformed payload before applying its person-only gate`)
  }
  assert.deepEqual(deps.names(), [], 'a person-only refusal touched the host')
})

test('profiles: list, create through the dialog, remove', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.deepEqual(await surface.run('agent:profiles', undefined, window), { ok: true, profiles: [{ id: 'p1', name: 'one' }] })
  assert.deepEqual(await surface.run('agent:profile-create', { name: 'work' }, window), { ok: true, profile: { id: 'p2', name: 'work', cwd: 'C:\\fake\\picked.png' } })
  assert.deepEqual(deps.calls.find(c => c.name === 'showOpenDialog').args[0], { title: 'Choose the folder agents in this profile work in', properties: ['openDirectory'] })
  const cancelled = createAgentCommandSurface(fakeDeps({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } }))
  assert.deepEqual(await cancelled.run('agent:profile-create', { name: 'work' }, window), { ok: true, profile: null })
  assert.deepEqual(await surface.run('agent:profile-remove', { profileId: 'p1' }, window), { ok: true, removed: true })
  assert.deepEqual(deps.calls.at(-1), { name: 'profiles.remove', args: ['p1'] })
  assert.equal((await refusal(surface.run('agent:profile-remove', { id: 'p1' }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
})

test('pick-attachment issues into the owning session only; pick-mention issues nothing', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  assert.deepEqual(await surface.run('agent:pick-attachment', { sessionId: 'chat-1' }, window), { ok: true, path: 'C:\\fake\\picked.png' })
  assert.deepEqual([...deps.agentSessions.get('chat-1').attachments], ['C:\\fake\\picked.png'])
  assert.equal((await refusal(surface.run('agent:pick-attachment', { sessionId: 'chat-1' }, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.equal(deps.names().filter(n => n === 'showOpenDialog').length, 1, 'the dialog opened for a caller that does not own the session')

  deps.calls.length = 0
  assert.deepEqual(await surface.run('agent:pick-mention', { sessionId: 'chat-1' }, window), { ok: true, path: 'C:\\fake\\picked.png' })
  assert.equal(deps.calls.find(c => c.name === 'showOpenDialog').args[0].defaultPath, 'C:\\fake\\workspace')
  assert.deepEqual([...deps.agentSessions.get('chat-1').attachments], ['C:\\fake\\picked.png'], 'a mention issued an attachment right')
  assert.equal((await refusal(surface.run('agent:pick-mention', { sessionId: 'chat-1' }, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
})

/* THE THIRD BUTTON'S SIBLING: R10, verbatim, "I still cant control V and
 * image to you please get that fixed". Controller's ruling: bytes come ONLY
 * from the renderer's own paste event (never clipboard.readImage() in main),
 * a size cap applies, and the allowlist gains a second feeder for this
 * command alone. */
test('paste-attachment issues into the owning session only, from the window alone, and rides the same send fence pick-attachment does', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)

  await startedSession(deps, surface, 'chat-2')

  const result = await surface.run('agent:paste-attachment', { sessionId: 'chat-1', mime: 'image/png', data: 'QQ==' }, window)
  assert.equal(result.ok, true)
  assert.match(result.path, /^C:\\fake\\paste-attachments\\img-\d+\.png$/, 'the path was not built by the injected save function alone')
  assert.equal(result.size, Buffer.from('QQ==', 'base64').length)
  assert.deepEqual([...deps.agentSessions.get('chat-1').attachments], [result.path])
  assert.equal(deps.agentSessions.get('chat-2').attachments.size, 0,
    'a paste issued into chat-1 also landed in a sibling session\'s allowlist -- the allowlist is per session')
  assert.deepEqual(deps.calls.find(c => c.name === 'savePasteAttachment').args, ['image/png', 1], 'the mime and decoded byte length did not reach the save function')

  /* THE SEND FENCE, UNCHANGED: a pasted path rides agent:send exactly the way
     a dialog-picked one does -- same allowlist, same Set, same check. */
  deps.calls.length = 0
  await surface.run('agent:send', { sessionId: 'chat-1', text: 'look', images: [{ path: result.path }] }, window)
  assert.deepEqual(deps.calls.at(-1).args[0], { sessionId: 'chat-1', text: 'look', images: [{ path: result.path }], origin: 'person' })

  /* Another owner's session: refused, and nothing written. */
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:paste-attachment', { sessionId: 'chat-1', mime: 'image/png', data: 'QQ==' }, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.ok(!deps.names().includes('savePasteAttachment'), 'a caller who does not own the session still reached the disk write')

  /* A mime this app does not accept: refused, before any write. */
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:paste-attachment', { sessionId: 'chat-1', mime: 'image/bmp', data: 'QQ==' }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
  assert.ok(!deps.names().includes('savePasteAttachment'), 'an unaccepted mime still reached the disk write')

  /* Bytes over the cap: refused, before the allowlist gains anything, and
     the write already happened -- MUTATION CHECK below proves the cap is
     read from real bytes, not merely present. */
  deps.calls.length = 0
  const tooBig = Buffer.alloc(MAX_PASTE_IMAGE_BYTES + 1, 1).toString('base64')
  const before = deps.agentSessions.get('chat-1').attachments.size
  assert.equal((await refusal(surface.run('agent:paste-attachment', { sessionId: 'chat-1', mime: 'image/png', data: tooBig }, window))).code, 'MC_AGENT_PASTE_IMAGE_TOO_LARGE')
  assert.equal(deps.agentSessions.get('chat-1').attachments.size, before, 'an oversized paste still entered the allowlist')

  /* A caller that is not the window: refused by name, even on its OWN
     session and even though it may write -- the paste gesture is a fact
     about THIS window, not about write consent. */
  await startedSession(deps, surface, 'remote-1', elsewhere)
  deps.calls.length = 0
  const refusedElsewhere = await refusal(surface.run('agent:paste-attachment', { sessionId: 'remote-1', mime: 'image/png', data: 'QQ==' }, elsewhere))
  assert.equal(refusedElsewhere.code, PASTE_WINDOW_REFUSAL)
  assert.equal(PASTE_WINDOW_REFUSAL, 'MC_AGENT_PASTE_REQUIRES_WINDOW')
  assert.deepEqual(deps.names(), [], 'a non-window caller reached a dependency before being refused')
})

/* parseAgentPasteAttachment / savePasteAttachment / MAX_PASTE_IMAGE_BYTES are
 * OPTIONAL on the factory (unlike every other paste-attachment dependency,
 * which fakeDeps() always supplies): a build that omits them must refuse the
 * one command that needs them, by name, rather than crash on a call to
 * undefined or read an absent MAX_PASTE_IMAGE_BYTES as no size cap. */
test('paste-attachment is OPTIONAL on the surface factory, and refuses by name rather than crashing or reading no limit when its deps are not wired', async () => {
  const deps = fakeDeps({ parseAgentPasteAttachment: undefined, savePasteAttachment: undefined, MAX_PASTE_IMAGE_BYTES: undefined })
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)

  deps.calls.length = 0
  const refused = await refusal(surface.run('agent:paste-attachment', { sessionId: 'chat-1', mime: 'image/png', data: 'QQ==' }, window))
  assert.equal(refused.code, 'MC_AGENT_PASTE_UNAVAILABLE')
  assert.equal(deps.agentSessions.get('chat-1').attachments.size, 0, 'a refused paste still entered the allowlist')
  assert.deepEqual(deps.names(), [], 'a refused paste reached a dependency before being refused')

  assert.throws(() => createAgentCommandSurface(fakeDeps({ MAX_PASTE_IMAGE_BYTES: 'eight' })), /MAX_PASTE_IMAGE_BYTES/,
    'a wrong-kind MAX_PASTE_IMAGE_BYTES did not refuse construction')
  assert.throws(() => createAgentCommandSurface(fakeDeps({ savePasteAttachment: 'not a function' })), /savePasteAttachment/,
    'a wrong-kind savePasteAttachment did not refuse construction')
})

test('interrupt, approval-answer, rewind, effort and close drive only an owned session', async () => {
  const deps = fakeDeps()
  let recordedBeforeRemoval = false
  deps.recordSessionEnd = (session, sessionId, reason) => {
    deps.calls.push({ name: 'recordSessionEnd', args: [sessionId, reason] })
    recordedBeforeRemoval = deps.agentSessions.get(sessionId) === session
    session.ended = true
  }
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  const drives = [
    ['agent:interrupt', { sessionId: 'chat-1' }, 'interrupt', { sessionId: 'chat-1' }],
    ['agent:approval-answer', { sessionId: 'chat-1', approvalId: 'ap-1', decision: 'approve' }, 'answerApproval', { sessionId: 'chat-1', approvalId: 'ap-1', decision: 'approve' }],
    ['agent:rewind', { sessionId: 'chat-1', turnId: 'turn-1' }, 'rewindSession', { sessionId: 'chat-1', turnId: 'turn-1' }],
    ['agent:effort', { sessionId: 'chat-1', effort: 'high' }, 'setSessionEffort', { sessionId: 'chat-1', effort: 'high' }],
    ['agent:mode', { sessionId: 'chat-1', modeId: 'plan' }, 'setSessionMode', { sessionId: 'chat-1', modeId: 'plan' }],
    ['agent:modes', { sessionId: 'chat-1' }, 'readSessionModes', { sessionId: 'chat-1' }],
  ]
  for (const [command, payload, hostCall, expected] of drives) {
    deps.calls.length = 0
    await surface.run(command, payload, window)
    assert.deepEqual(deps.calls.at(-1), { name: hostCall, args: [expected] }, command)
    deps.calls.length = 0
    assert.equal((await refusal(surface.run(command, payload, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION', command)
    assert.deepEqual(deps.names(), [], `${command} touched the host for a session the caller does not own`)
  }
  assert.equal((await refusal(surface.run('agent:effort', { sessionId: 'chat-1', effort: 'banana' }, window))).code, 'MC_AGENT_EFFORT_UNKNOWN')

  deps.calls.length = 0
  const closed = await surface.run('agent:close', { sessionId: 'chat-1' }, window)
  assert.deepEqual(closed, { sessionId: 'chat-1', closed: true })
  assert.deepEqual(deps.names(), ['closeSession', 'recordSessionEnd'], 'closed is recorded AFTER the close resolves')
  assert.deepEqual(deps.calls[1].args, ['chat-1', 'closed'])
  assert.equal(recordedBeforeRemoval, true, 'closed is recorded before the session leaves the map')
  assert.ok(!deps.agentSessions.has('chat-1'), 'and the session leaves the map')

  /* A close that rejects leaves the session and writes no ending. */
  await startedSession(deps, surface, 'chat-3')
  deps.host.closeSession = async () => { const e = new Error('x'); e.code = 'AGENT_CLOSE_FAILED'; throw e }
  assert.equal((await refusal(surface.run('agent:close', { sessionId: 'chat-3' }, window))).code, 'AGENT_CLOSE_FAILED')
  assert.ok(deps.agentSessions.has('chat-3'))
  assert.ok(!deps.names().includes('recordSessionEnd'))
})

test('native opaque approval ids reach the owned host intact within the ACP bound', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  const request = { sessionId: 'chat-1', approvalId: 'ap-native', decision: 'x'.repeat(512) }
  deps.calls.length = 0
  await surface.run('agent:approval-answer', request, window)
  assert.deepEqual(deps.calls.at(-1), { name: 'answerApproval', args: [request] })
  deps.calls.length = 0
  await assert.rejects(surface.run('agent:approval-answer', { ...request, decision: 'x'.repeat(513) }, window))
  assert.deepEqual(deps.names(), [], 'an oversized answer must never reach the adapter')
  await assert.rejects(surface.run('agent:approval-answer', request, otherWindow))
  assert.deepEqual(deps.names(), [], 'long option ids cannot bypass session ownership')
})

/* CLOSE'S OWN accountRecovery ALLOW-LIST, TESTED ON ITS OWN.
 *
 * 'agent:close' accepts a second, optional field beside sessionId --
 * accountRecovery: { recoveryId } -- carried through to closeSession() so a
 * close made for account-recovery reasons can name the ticket it belongs to.
 * That allow-list (top level: sessionId, accountRecovery; nested:
 * recoveryId) had no test naming it directly before this one -- the two
 * fields are exercised together only inside the longer resume/recovery
 * scenarios elsewhere in this file, which prove the FEATURE works but never
 * assert what happens to an UNEXPECTED field at either level, which is the
 * one thing an allow-list exists to refuse. */
test('close: accountRecovery carries a bounded recoveryId through, and an unexpected field at either level refuses', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface, 'chat-recovery')
  await surface.run('agent:close', { sessionId: 'chat-recovery', accountRecovery: { recoveryId: 'ticket-7' } }, window)
  assert.deepEqual(deps.calls[0], { name: 'closeSession', args: [{ sessionId: 'chat-recovery', accountRecovery: { recoveryId: 'ticket-7' } }] })

  await startedSession(deps, surface, 'chat-recovery-2')
  const topLevel = await refusal(surface.run('agent:close', { sessionId: 'chat-recovery-2', accountRecovery: { recoveryId: 'ticket-7' }, extra: 1 }, window))
  assert.equal(topLevel.code, 'MC_AGENT_INVALID_PAYLOAD')
  assert.ok(deps.agentSessions.has('chat-recovery-2'), 'a refused close must not close the session')

  const nested = await refusal(surface.run('agent:close', { sessionId: 'chat-recovery-2', accountRecovery: { recoveryId: 'ticket-7', extra: 1 } }, window))
  assert.equal(nested.code, 'MC_AGENT_INVALID_PAYLOAD')
  assert.ok(deps.agentSessions.has('chat-recovery-2'), 'a refused nested field must not close the session either')
})

test('models: a named session must be owned; no session asks the engine catalog outright', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  await surface.run('agent:models', undefined, window)
  assert.deepEqual(deps.calls.at(-1), { name: 'listEngineModels', args: [{}] })
  await surface.run('agent:models', { sessionId: 'chat-1' }, window)
  assert.deepEqual(deps.calls.at(-1), { name: 'listEngineModels', args: [{ sessionId: 'chat-1' }] })
  assert.equal((await refusal(surface.run('agent:models', { sessionId: 'chat-1' }, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
  /* No host yet: the same TypeError-turned-AGENT_SESSION_FAILED the handler raised. */
  const hostless = createAgentCommandSurface(fakeDeps({ currentAgentHost: () => null }))
  assert.equal((await refusal(hostless.run('agent:models', {}, window))).code, 'AGENT_SESSION_FAILED')
})

test('org: each command shapes its arguments exactly as the handler did and answers the record verbatim', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  const cases = [
    ['org:read', undefined, 'org.read', []],
    ['org:reparent', { agentId: 7, parentId: undefined, expectedRevision: 3 }, 'org.reparent', [{ agentId: '7', parentId: null, expectedRevision: 3 }]],
    ['org:reparent', { agentId: 'a', parentId: 9 }, 'org.reparent', [{ agentId: 'a', parentId: '9', expectedRevision: undefined }]],
    ['org:assign-role', { agentId: 'a', role: 'lead', expectedRevision: 1 }, 'org.assignRole', [{ agentId: 'a', role: 'lead', expectedRevision: 1 }]],
    ['org:assign-role', null, 'org.assignRole', [{ agentId: '', role: '', expectedRevision: undefined }]],
    ['org:ensure-seat', { id: 'node-1-abc', role: 'manager', provider: 'claude', displayName: 'Manager 1', expectedRevision: 2 }, 'org.ensureSeat', [{ id: 'node-1-abc', role: 'manager', provider: 'claude', displayName: 'Manager 1', expectedRevision: 2 }]],
    ['org:ensure-seat', { id: 'node-2-def', role: 'worker' }, 'org.ensureSeat', [{ id: 'node-2-def', role: 'worker', expectedRevision: undefined }]],
    ['org:release-seat', { id: 'node-1-abc', expectedRevision: 2 }, 'org.releaseSeat', [{ id: 'node-1-abc', expectedRevision: 2 }]],
    ['org:release-seat', { id: 'node-2-def' }, 'org.releaseSeat', [{ id: 'node-2-def', expectedRevision: undefined }]],
    ['org:create-role', { id: 'r', baseDefaultRole: '', rules: ['x'] }, 'org.createRole', [{ id: 'r', baseDefaultRole: null, rules: ['x'] }]],
    ['org:create-role', { id: 'r', baseDefaultRole: 'worker', rules: ['x'] }, 'org.createRole', [{ id: 'r', baseDefaultRole: 'worker', rules: ['x'] }]],
    ['org:edit-role', { id: 'r', rules: ['y'] }, 'org.editRole', [{ id: 'r', rules: ['y'] }]],
    ['org:reset-role', { id: 'r' }, 'org.resetRole', [{ id: 'r' }]],
    ['org:reset', undefined, 'org.resetOrg', []],
    ['org:export', undefined, 'org.exportOrg', []],
  ]
  for (const [command, payload, recordCall, expectedArgs] of cases) {
    deps.calls.length = 0
    const answer = await surface.run(command, payload, window)
    assert.equal(answer.ok, true, command)
    assert.deepEqual(deps.calls, [{ name: recordCall, args: expectedArgs }], command)
  }
})

test('role CRUD forwards only an exact eight-boolean capability posture and refuses malformed packets before mutation', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  const capabilities = {
    orgRoot: false,
    singleSeat: false,
    mayClaimWork: true,
    mayWakeReports: true,
    requiresMutationContext: false,
    mayUseMissionBridge: true,
    mayReportMissionBridge: true,
    mayMutateMissionBridge: true,
  }
  await surface.run('org:create-role', {
    id: 'operator',
    baseDefaultRole: 'worker',
    rules: { owns: 'Operate.', mustNot: 'Broaden.', handoff: 'Report.' },
    capabilities,
  }, window)
  assert.deepEqual(deps.calls.at(-1), {
    name: 'org.createRole',
    args: [{
      id: 'operator',
      baseDefaultRole: 'worker',
      rules: { owns: 'Operate.', mustNot: 'Broaden.', handoff: 'Report.' },
      capabilities,
    }],
  })

  for (const malformed of [
    null,
    { orgRoot: false },
    { ...capabilities, mayClaimWork: 'yes' },
    { ...capabilities, futureAuthority: true },
  ]) {
    for (const command of ['org:create-role', 'org:edit-role']) {
      deps.calls.length = 0
      const refused = await refusal(surface.run(command, { id: 'operator', rules: {}, capabilities: malformed }, window))
      assert.equal(refused.code, 'MC_AGENT_ROLE_CAPABILITIES_INVALID', `${command} accepted ${JSON.stringify(malformed)}`)
      assert.deepEqual(deps.calls, [], `${command} reached the role store with a malformed posture`)
    }
  }
})

/* ---------- the read-only principal ---------- */

test('mayWrite:false refuses every write with the documented code before touching anything, and every read still answers', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  await surface.run('agent:pick-attachment', { sessionId: 'chat-1' }, window)
  const payloads = {
    'agent:availability': undefined,
    'agent:confinement': undefined,
    'agent:tools': undefined,
    'agent:local-messages': { limit: 5 },
    'agent:startable-tiers': undefined,
    'agent:session-accounts': undefined,
    'agent:desktop-sessions': undefined,
    'agent:desktop-tree': undefined,
    'agent:desktop-transcript': { sessionId: 'chat-1' },
    'agent:desktop-send': { sessionId: 'chat-1', text: 'hello' },
    'agent:desktop-stop': { requestId: 'stop-1' },
    'agent:desktop-stop-status': { requestId: 'stop-1' },
    'agent:history': { limit: 2 },
    'agent:usage': { limit: 2 },
    'agent:start': { sessionId: 'ro-1' },
    'agent:continuations': { action: 'read' },
    'agent:send': { sessionId: 'chat-1', text: 'hi' },
    'agent:send-automatic': { sessionId: 'chat-1', text: 'continue' },
    'agent:tree-links': undefined,
    'agent:tree-link': { from: 'node-a', to: 'node-b', connected: true },
    'agent:work-status': { sessionId: 'chat-1' },
    'agent:session-activity': { sessionId: 'chat-1' },
    'agent:tree-address': { sessionId: 'chat-1', selfName: 'Worker', managerName: 'Manager', treeKey: 'tree-1' },
    'agent:tree-adopt': { sessionId: 'chat-1', selfName: 'Worker', treeKey: 'node-1', requestKeys: { treeAnchors: ['node-1'], threadId: 'node-1' } },
    'agent:request': { scope: 'tree', words: 'w' },
    'agent:request-edit': { id: 'RT1', key: 'k1', words: 'w2' },
    'agent:request-remove': { id: 'RT1', key: 'k1' },
    'agent:request-decide': { id: 'R1', decision: 'approve' },
    'agent:request-resolve': { id: 'R1', status: 'done' },
    'agent:task-complete': { id: 'T1' },
    'agent:task-remove': { id: 'T1' },
    'agent:ask-answer': { id: 'A1', words: 'answer words' },
    'agent:ask-decline': { id: 'A1' },
    'agent:ask-remove': { id: 'A1' },
    'agent:requests': { scope: 'tree' },
    'agent:ledger': { scope: 'all' },
    'agent:ledger-reset-preview': { kind: 'T' },
    'agent:ledger-reset-confirm': { kind: 'T', revision: 1, token: 'a'.repeat(64) },
    'agent:ledger-custody-preview': {},
    'agent:ledger-custody-confirm': { revision: 1, token: 'a'.repeat(64) },
    'agent:profiles': undefined,
    'agent:profile-create': { name: 'n' },
    'agent:profile-remove': { profileId: 'p1' },
    'agent:pick-attachment': { sessionId: 'chat-1' },
    'agent:paste-attachment': { sessionId: 'chat-1', mime: 'image/png', data: 'QQ==' },
    'agent:pick-mention': { sessionId: 'chat-1' },
    'agent:goal': { sessionId: 'chat-1', operation: 'get' },
    'agent:interrupt': { sessionId: 'chat-1' },
    'agent:reserve-send-now': { sessionId: 'chat-1' },
    'agent:release-send-now': { sessionId: 'chat-1', token: 123 },
    'agent:approval-answer': { sessionId: 'chat-1', approvalId: 'a', decision: 'approve' },
    'agent:rewind': { sessionId: 'chat-1', turnId: 't' },
    'agent:effort': { sessionId: 'chat-1', effort: 'low' },
    'agent:models': { sessionId: 'chat-1' },
    'agent:owner-context': {},
    'agent:image-queue': { operation: 'read' },
    'agent:switch': { operation: 'status', sessionId: 'chat-1', operationId: 'switch-1' },
    'agent:modes': { sessionId: 'chat-1' },
    'agent:mode': { sessionId: 'chat-1', modeId: 'plan' },
    'agent:close': { sessionId: 'chat-1' },
    'org:read': undefined,
    'org:reparent': { agentId: 'a', parentId: null },
    'org:assign-role': { agentId: 'a', role: 'r' },
    'org:ensure-seat': { id: 'node-1', role: 'manager' },
    'org:release-seat': { id: 'node-1' },
    'org:create-role': { id: 'r', rules: [] },
    'org:edit-role': { id: 'r', rules: [] },
    'org:reset-role': { id: 'r' },
    'org:reset': undefined,
    'org:export': undefined,
  }
  assert.deepEqual(Object.keys(payloads).sort(), [...surface.commands].sort(), 'this test must name every command')

  const writes = surface.commands.filter(c => surface.isWrite(c))
  const reads = surface.commands.filter(c => !surface.isWrite(c))
  assert.deepEqual(writes.sort(), [
    'agent:approval-answer', 'agent:ask-answer', 'agent:ask-decline', 'agent:ask-remove', 'agent:close', 'agent:continuations', 'agent:desktop-send', 'agent:desktop-stop', 'agent:effort', 'agent:goal', 'agent:image-queue', 'agent:interrupt', 'agent:ledger-custody-confirm', 'agent:ledger-custody-preview', 'agent:ledger-reset-confirm', 'agent:ledger-reset-preview', 'agent:mode', 'agent:paste-attachment', 'agent:pick-attachment',
    'agent:profile-create', 'agent:profile-remove', 'agent:release-send-now', 'agent:request', 'agent:request-decide', 'agent:request-edit', 'agent:request-remove', 'agent:request-resolve', 'agent:reserve-send-now',
    'agent:rewind', 'agent:send', 'agent:send-automatic', 'agent:start', 'agent:switch', 'agent:task-complete', 'agent:task-remove', 'agent:tree-address', 'agent:tree-adopt', 'agent:tree-link',
    'org:assign-role', 'org:create-role', 'org:edit-role', 'org:ensure-seat', 'org:release-seat', 'org:reparent', 'org:reset', 'org:reset-role',
  ], 'the write inventory changed -- re-read every command before accepting this')
  assert.equal(writes.length + reads.length, surface.commands.length, 'every command must be classified as read or write')

  for (const command of writes) {
    deps.calls.length = 0
    const refused = await refusal(surface.run(command, payloads[command], readOnly))
    assert.equal(refused.code, READ_ONLY_REFUSAL, `${command} was not refused to a read-only caller`)
    assert.equal(READ_ONLY_REFUSAL, 'MC_AGENT_PRINCIPAL_READ_ONLY')
    assert.match(refused.message, /a read-only caller may read this computer's agents but not change them/, command)
    assert.match(refused.message, new RegExp(command.replace(/[-]/g, '\\-')), 'the sentence names the command')
    assert.deepEqual(deps.names(), [], `${command} touched a dependency before refusing a read-only caller`)
  }
  assert.ok(deps.agentSessions.has('chat-1'), 'a read-only close took a session away')

  for (const command of reads) {
    if (command.startsWith('agent:desktop-')) {
      assert.equal((await refusal(surface.run(command, payloads[command], window))).code, PRINCIPAL_REFUSAL)
      assert.equal((await refusal(surface.run(command, payloads[command], readOnly))).code, PRINCIPAL_REFUSAL)
      continue // Desktop reads are relay-only, tested with the real relay controller separately.
    }
    deps.calls.length = 0
    const asWindow = await surface.run(command, payloads[command], window)
    const windowCalls = JSON.stringify(deps.calls)
    deps.calls.length = 0
    const asReadOnly = await surface.run(command, payloads[command], readOnly)
    assert.deepEqual(asReadOnly, asWindow, `${command} answers a read-only caller differently from the window`)
    assert.equal(JSON.stringify(deps.calls), windowCalls, `${command} took a different path for a read-only caller`)
  }
})

/* ---------- the reconnect read a reloaded page depends on ---------- */

test('session activity is answered for this window\'s own live session and refused for anything else', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  deps.host.sessionActivity = sessionId => (sessionId === 'chat-1' ? { busy: true, closing: false, directUserTurn: true } : null)

  assert.deepEqual(await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window),
    { ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 },
    'the window is told whether its own session is working, and how its last turn ended')

  // The provider's own word for the last turn, as the main process recorded it.
  deps.agentSessions.get('chat-1').lastTurnStatus = 'completed'
  deps.agentSessions.get('chat-1').turnsCompleted = 2
  deps.host.sessionActivity = () => ({ busy: false, closing: false, directUserTurn: false })
  assert.deepEqual(await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window),
    { ok: true, busy: false, closing: false, lastTurnStatus: 'completed', turnsCompleted: 2 },
    'an idle session reports the recorded outcome rather than leaving the reader to guess')

  // Not this window: the same refusal send and close give, and no read of the host.
  assert.equal((await refusal(surface.run('agent:session-activity', { sessionId: 'chat-1' }, elsewhere))).code, PRINCIPAL_REFUSAL)
  assert.equal((await refusal(surface.run('agent:session-activity', { sessionId: 'chat-1' }, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.equal((await refusal(surface.run('agent:session-activity', { sessionId: 'never-started' }, window))).code, 'MC_AGENT_UNKNOWN_SESSION')

  /* Recorded from provider output, so it crosses as a bare word or not at
     all: anything else is reported as no recorded outcome. */
  for (const recorded of ['turn failed badly', 'completed\nfailed', 'x'.repeat(65), '', 42]) {
    deps.agentSessions.get('chat-1').lastTurnStatus = recorded
    const answer = await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window)
    assert.equal(answer.lastTurnStatus, null, `${JSON.stringify(recorded)} must not cross as a status`)
  }
  deps.agentSessions.get('chat-1').lastTurnStatus = 'end_turn'
  assert.equal((await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window)).lastTurnStatus, 'end_turn',
    'a real provider word still crosses verbatim')

  deps.agentSessions.get('chat-1').lastTurnId = 'native-turn-2'
  assert.equal((await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window)).lastTurnId, 'native-turn-2')
  for (const invalid of ['', 'bad\nturn', 'x'.repeat(513), 42]) {
    deps.agentSessions.get('chat-1').lastTurnId = invalid
    assert.equal(Object.hasOwn(await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window), 'lastTurnId'), false)
  }

  // A session the host no longer holds is not reported as idle.
  deps.host.sessionActivity = () => null
  assert.deepEqual(await surface.run('agent:session-activity', { sessionId: 'chat-1' }, window),
    { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' })
})

/* ---------- the dialog gate ---------- */

test('a principal that is not the window is refused every dialog, and the dialog never opens', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface, 'remote-1', elsewhere)
  const dialogs = surface.commands.filter(c => surface.needsDialog(c))
  assert.deepEqual(dialogs.sort(), ['agent:pick-attachment', 'agent:pick-mention', 'agent:profile-create'])
  const payloads = {
    'agent:pick-attachment': { sessionId: 'remote-1' },
    'agent:pick-mention': { sessionId: 'remote-1' },
    'agent:profile-create': { name: 'n' },
  }
  for (const command of dialogs) {
    deps.calls.length = 0
    const refused = await refusal(surface.run(command, payloads[command], elsewhere))
    assert.equal(refused.code, DIALOG_REFUSAL, command)
    assert.equal(DIALOG_REFUSAL, 'MC_AGENT_DIALOG_REQUIRES_WINDOW')
    assert.deepEqual(deps.names(), [], `${command} opened a dialog for a caller that is not at the keyboard`)
  }
  assert.equal(deps.agentSessions.get('remote-1').attachments.size, 0, 'an allowlist was issued without a dialog')
  /* The non-dialog commands still serve such a principal on its OWN session,
     and refuse it the window's. */
  await surface.run('agent:interrupt', { sessionId: 'remote-1' }, elsewhere)
  await startedSession(deps, surface, 'chat-1', window)
  assert.equal((await refusal(surface.run('agent:interrupt', { sessionId: 'chat-1' }, elsewhere))).code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.equal((await refusal(surface.run('agent:interrupt', { sessionId: 'remote-1' }, window))).code, 'MC_AGENT_UNKNOWN_SESSION')
})

test('relay event fan-out handles an asynchronous sink rejection', async () => {
  const messages = []
  const deps = fakeDeps({
    emitRelayEvent: async () => { throw new Error('relay disconnected') },
    log: message => messages.push(message),
  })
  deps.agentSessions.set('relay-1', { ownerKind: 'relay' })
  const surface = createAgentCommandSurface(deps)

  assert.equal(surface.forwardSessionEvent({ sessionId: 'relay-1', type: 'turn' }), true)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(surface.relayEventDropCount(), 1)
  assert.match(messages[0], /relay event sink rejected/)
})

test('relay event fan-out preserves the one bounded terminal packet verbatim', async () => {
  const delivered = []
  const deps = fakeDeps({ emitRelayEvent: packet => { delivered.push(packet) } })
  deps.agentSessions.set('relay-ended', { ownerKind: 'relay', state: 'ended', ended: true })
  const surface = createAgentCommandSurface(deps)
  const packet = Object.freeze({
    sessionId: 'relay-ended',
    event: Object.freeze({
      type: 'session_ended',
      reason: 'exited',
      exit: Object.freeze({ code: 0, signal: null }),
    }),
  })
  assert.equal(surface.forwardSessionEvent(packet), true)
  assert.deepEqual(delivered, [packet])
  assert.equal(delivered[0], packet, 'the relay received a rewritten terminal packet')
})

test('org:ensure-seat bounds the seat id, role and provider before the record is touched', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal((await refusal(surface.run('org:ensure-seat', { id: 'Node One', role: 'manager' }, window))).code, 'MC_AGENT_SEAT_ID_INVALID')
  assert.equal((await refusal(surface.run('org:ensure-seat', { id: 'node-1', role: '' }, window))).code, 'MC_AGENT_SEAT_ROLE_INVALID')
  assert.equal((await refusal(surface.run('org:ensure-seat', { id: 'node-1', role: 'manager', provider: 'openai' }, window))).code, 'MC_AGENT_SEAT_PROVIDER_INVALID')
  assert.deepEqual(deps.calls.filter(call => call.name === 'org.ensureSeat'), [], 'a refused packet never reaches the record')
  const answer = await surface.run('org:ensure-seat', { id: 'node-1', role: 'manager', provider: 'claude', managerId: null }, window)
  assert.equal(answer.ok, true)
  assert.deepEqual(deps.calls.at(-1), { name: 'org.ensureSeat', args: [{ id: 'node-1', role: 'manager', provider: 'claude', managerId: null, expectedRevision: undefined }] })
})

test('org:release-seat bounds the seat id before the record is touched', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  assert.equal((await refusal(surface.run('org:release-seat', { id: 'Node One' }, window))).code, 'MC_AGENT_SEAT_ID_INVALID')
  assert.equal((await refusal(surface.run('org:release-seat', {}, window))).code, 'MC_AGENT_SEAT_ID_INVALID')
  assert.deepEqual(deps.calls.filter(call => call.name === 'org.releaseSeat'), [], 'a refused packet never reaches the record')
  const answer = await surface.run('org:release-seat', { id: 'node-1', expectedRevision: 4 }, window)
  assert.equal(answer.ok, true)
  assert.deepEqual(deps.calls.at(-1), { name: 'org.releaseSeat', args: [{ id: 'node-1', expectedRevision: 4 }] })
})


test('recovery inherits launch choices after close, rechecks role authority, and keeps the current node address', async () => {
 const deps = fakeDeps(); const surface = createAgentCommandSurface(deps)
 const roleBinding = { agentId: 'builder-seat', id: 'builder', expectedOrgRevision: 1, expectedRoleRevision: 1 }
 deps.agentOrgRecord.read = () => ({ ok: true, org: { revision: 20, agents: [{ id: 'builder-seat', role: 'builder', enabled: true }] }, roles: [{ id: 'builder', revision: 2 }] })
 await surface.run('agent:start', { sessionId: 'original', tier: 'luna', profileId: 'profile-1', roleBinding }, window)
 await surface.run('agent:close', { sessionId: 'original' }, window)
 const current = { selfName: 'Renamed builder', managerName: 'New manager' }
 await surface.run('agent:start', { sessionId: 'replacement', replacesSessionId: 'original', accountRecovery: { recoveryId: 'ticket-1' }, treeIdentity: current }, window)
 const request = deps.calls.filter(c => c.name === 'startSession').at(-1).args[0]
 assert.equal(request.tier, 'luna'); assert.deepEqual(request.treeIdentity, current)
 assert.equal(deps.calls.filter(c => c.name === 'org.resolveRoleBinding').length, 2)
 assert.equal(deps.calls.filter(c => c.name === 'org.resolveRoleBinding').at(-1).args[0].expectedOrgRevision, 20)
 assert.equal(request.accountRecovery.recoveryId, 'ticket-1')
 const stranger = { ...window, owner: { id: 'other-window' } }
 await assert.rejects(surface.run('agent:start', { sessionId: 'stolen', replacesSessionId: 'original', accountRecovery: { recoveryId: 'ticket-1' } }, stranger), { code: 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE' })
 assert.equal(deps.calls.filter(c => c.name === 'startSession').length, 2)
})


test('accepted starts and tree moves report transcript binding without retrying accepted operations', async () => {
 const bindings = []
 const deps = fakeDeps({ recordTranscriptBinding: async value => { bindings.push(value); throw new Error('Storage refused') } })
 const surface = createAgentCommandSurface(deps)
 const requestKeys = { threadId: 'node-1', treeAnchors: ['root', 'node-1'] }
 const started = await surface.run('agent:start', { sessionId: 'original', requestKeys }, window)
 assert.equal(started.sessionId, 'original')
 const moved = await surface.run('agent:tree-address', { sessionId: 'original', selfName: 'Worker', managerName: 'Controller', treeKey: 'new-root',
  requestKeys: { ...requestKeys, treeAnchors: ['new-root', 'node-1'] } }, window)
 assert.equal(moved.ok, true)
 assert.deepEqual(bindings, [{ sessionId: 'original', nodeId: 'node-1', treeId: 'root' }, { sessionId: 'original', nodeId: 'node-1', treeId: 'new-root' }])
})

test('accepted sends report canonical transcript ingress and preserve actual model for recovery', async () => {
 const recorded = []
 const deps = fakeDeps({ recordAcceptedTranscriptSend: async value => { recorded.push(value); throw new Error('Storage refused') } })
 const surface = createAgentCommandSurface(deps)
 await surface.run('agent:start', { sessionId: 'original', tier: 'luna' }, window)
 const transcriptPrompt = { text: 'Continue the task', additions: [{ kind: 'role', text: 'Host-consumed role directions.' }] }
 deps.host.sendTurn = async () => ({ sessionId: 'original', turnId: 'turn-confirmed', tier: 'sol', transcriptPrompt })
 const result = await surface.run('agent:send', { sessionId: 'original', text: 'Continue the task', model: 'chosen-model' }, window)
 assert.equal(result.turnId, 'turn-confirmed')
 assert.deepEqual(recorded, [{ sessionId: 'original', text: 'Continue the task', turnId: 'turn-confirmed', transcriptPrompt }])
 deps.host.sendTurn = async () => { throw new Error('Provider refused') }
 await assert.rejects(surface.run('agent:send', { sessionId: 'original', text: 'Refused text' }, window))
 assert.equal(recorded.length, 1)
 await surface.run('agent:close', { sessionId: 'original' }, window)
 await surface.run('agent:start', { sessionId: 'replacement', replacesSessionId: 'original', accountRecovery: { recoveryId: 'ticket-1' },
  treeIdentity: { selfName: 'Worker', managerName: 'Controller' } }, window)
 assert.equal(deps.calls.filter(c => c.name === 'startSession').at(-1).args[0].tier, 'sol')
})

for (const outcome of ['accepted', 'refused', 'thrown']) test(`automatic recovery retains the last accepted effort after a live change (${outcome})`, async () => {
 const deps = fakeDeps(); const surface = createAgentCommandSurface(deps)
 await surface.run('agent:start', { sessionId: 'original', tier: 'luna', effort: 'xhigh' }, window)
 await surface.run('agent:effort', { sessionId: 'original', effort: 'medium' }, window)
 deps.host.setSessionEffort = async request => {
  if (outcome === 'thrown') throw Object.assign(new Error('Change refused'), { code: 'AGENT_EFFORT_FIXED' })
  return outcome === 'refused' ? { ok: false } : request
 }
 const change = surface.run('agent:effort', { sessionId: 'original', effort: 'low' }, window)
 if (outcome === 'thrown') await assert.rejects(change)
 else await change
 await surface.run('agent:close', { sessionId: 'original' }, window)
 await surface.run('agent:start', { sessionId: 'replacement', replacesSessionId: 'original',
  accountRecovery: { recoveryId: 'ticket-1' }, treeIdentity: { selfName: 'Worker', managerName: 'Controller' } }, window)
 const request = deps.calls.filter(c => c.name === 'startSession').at(-1).args[0]
 assert.equal(request.effort, outcome === 'accepted' ? 'low' : 'medium')
 assert.equal(request.tier, 'luna')
})

test('production start parser and surface preserve Claude launch choices from a minimal headless recovery request', async () => {
 const at = MAIN.indexOf('function parseAgentStart(value) {'); const end = MAIN.indexOf('\n}', at)
 assert.ok(at > 0 && end > at)
 const productionParse = new Function('agentPayload', 'boundedAgentString', 'agentIpcError', 'AGENT_EFFORT_VALUES',
   'MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'MAX_ACCOUNT_NAME_LENGTH',
   MAIN.slice(at, end + 2) + '; return parseAgentStart;')(
   agentPayload, boundedAgentString, agentIpcError, AGENT_EFFORT_VALUES, 128, 32768, 128, 64)
 const deps = fakeDeps({ parseAgentStart: productionParse }); const surface = createAgentCommandSurface(deps)
 const identity = { treeIdentity: { selfName: 'Worker', managerName: 'Controller' }, requestKeys: { treeAnchors: ['root', 'node-42'], threadId: 'node-42' } }
 await surface.run('agent:start', { sessionId: 'claude-original', tier: 'claude-fable', effort: 'max', profileId: 'profile-1', ...identity }, window)
 await surface.run('agent:close', { sessionId: 'claude-original' }, window)
 const minimal = { sessionId: 'claude-new', surface: 'fleet-tree', replacesSessionId: 'claude-original', accountRecovery: { recoveryId: 'ticket-42' }, ...identity }
 assert.equal(Object.hasOwn(productionParse(minimal), 'tier'), false)
 assert.equal(Object.hasOwn(productionParse(minimal), 'effort'), false)
 assert.equal(Object.hasOwn(productionParse(minimal), 'profileId'), false)
 await surface.run('agent:start', minimal, window)
 const actual = deps.calls.filter(c => c.name === 'startSession').at(-1).args[0]
 assert.equal(actual.tier, 'claude-fable'); assert.equal(actual.effort, 'max')
 assert.equal(actual.cwd, deps.calls.filter(c => c.name === 'startSession')[0].args[0].cwd)
 assert.deepEqual(actual.accountRecovery, { recoveryId: 'ticket-42' }); assert.equal(actual.requestKeys.threadId, 'node-42')
})


test('manual account continuation crosses the real parser only for an explicit fresh window start', async () => {
 const at = MAIN.indexOf('function parseAgentStart(value) {'); const end = MAIN.indexOf('\n}', at)
 const productionParse = new Function('agentPayload', 'boundedAgentString', 'agentIpcError', 'AGENT_EFFORT_VALUES',
  'MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'MAX_ACCOUNT_NAME_LENGTH',
  MAIN.slice(at, end + 2) + '; return parseAgentStart;')(
  agentPayload, boundedAgentString, agentIpcError, AGENT_EFFORT_VALUES, 128, 32768, 128, 64)
 const deps = fakeDeps({ parseAgentStart: productionParse }); const surface = createAgentCommandSurface(deps)
 const request = { sessionId: 'manual-new', surface: 'fleet-tree', tier: 'claude-opus', effort: 'medium',
  replacesSessionId: 'closed-old', continueFromAccount: 'original@example.com',
  treeIdentity: { selfName: 'Controller', managerName: null }, requestKeys: { treeAnchors: ['same-node'], threadId: 'same-node' } }
 for (const extra of [{ resumeThreadId: 'old-native-thread' }, { resumeAccount: 'original@example.com' },
  { accountRecovery: { recoveryId: 'auto-ticket' } }, { continueFromAccount: '' }, { continueFromAccount: 'x'.repeat(65) },
  { treeIdentity: null }, { replacesSessionId: undefined }]) assert.throws(() => productionParse({ ...request, ...extra }))
 await assert.rejects(surface.run('agent:start', request, { kind: 'relay', owner: 'remote-owner', mayWrite: true, label: 'remote caller' }), { code: 'AGENT_MANUAL_ACCOUNT_CONTINUATION_WINDOW_ONLY' })
 await assert.rejects(surface.run('agent:start', request, readOnly), { code: READ_ONLY_REFUSAL })
 assert.equal(deps.calls.filter(c => c.name === 'startSession').length, 0)
 await surface.run('agent:start', request, window)
 const launched = deps.calls.find(c => c.name === 'startSession').args[0]
 assert.equal(launched.continueFromAccount, 'original@example.com')
 assert.equal(launched.tier, 'claude-opus'); assert.equal(launched.effort, 'medium')
 assert.equal(launched.requestKeys.threadId, 'same-node'); assert.equal(launched.resumeThreadId, undefined)
})

test('direct tree links require the native window and validate before touching the host', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  const request = { from: 'node-a', to: 'node-b', connected: true }
  assert.equal((await surface.run('agent:tree-link', request, window)).ok, true)
  assert.deepEqual(deps.calls.at(-1), { name: 'setTreeLink', args: [request] })
  for (const kind of ['agent-session', 'relay']) {
    deps.calls.length = 0
    assert.equal((await refusal(surface.run('agent:tree-link', request, { ...window, kind }))).code, PRINCIPAL_REFUSAL)
    assert.deepEqual(deps.names(), [])
  }
  deps.calls.length = 0
  for (const payload of [{ ...request, connected: 'yes' }, { ...request, from: 'x'.repeat(129) }, { ...request, sessionId: 'injected' }]) {
    await refusal(surface.run('agent:tree-link', payload, window))
    assert.deepEqual(deps.names(), [])
  }
})

test('local message cursors survive the shell boundary and malformed positions never reach the journal', async () => {
  const reads = []
  const surface = createAgentCommandSurface(fakeDeps({ requireModule: () => ({ ownerJournal: async options => { reads.push(options); return { ok: true, messages: [] } } }) }))
  assert.equal((await surface.run('agent:local-messages', { cursor: 217, limit: 200 }, window)).ok, true)
  assert.deepEqual(reads, [{ cursor: 217, limit: 200 }])
  for (const cursor of [-1, 1.5, '217', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await surface.run('agent:local-messages', { cursor }, window)).ok, false)
  }
  assert.equal(reads.length, 1)
})

test('persistent recovery uses the real start parser, current profile and role, and ordinary visible spawn accounting', async () => {
  const at = MAIN.indexOf('function parseAgentStart(value) {'), end = MAIN.indexOf('\n}', at)
  const productionParse = new Function('agentPayload', 'boundedAgentString', 'agentIpcError', 'AGENT_EFFORT_VALUES',
    'MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'MAX_ACCOUNT_NAME_LENGTH',
    MAIN.slice(at, end + 2) + '; return parseAgentStart;')(
    agentPayload, boundedAgentString, agentIpcError, AGENT_EFFORT_VALUES, 128, 32768, 128, 64)
  const deps = fakeDeps({ parseAgentStart: productionParse })
  const role = { id: 'worker', revision: 8, rules: [], owns: 'Current work.', mustNot: 'Broaden.', handoff: 'Report.' }
  const bindings = [], retained = []
  deps.agentOrgRecord.read = () => ({ ok: true, org: { revision: 9 }, roles: [role] })
  deps.agentOrgRecord.resolveRoleBinding = input => {
    bindings.push(input)
    return { ok: true, agent: { id: 'saved-node' }, role, authority: { agentId: 'saved-node', provider: 'codex',
      roleId: 'worker', expectedOrgRevision: 9, expectedRoleRevision: 8 } }
  }
  const descriptor = { sessionId: 'recovered', resumeThreadId: 'native-thread', resumeThreadProvider: 'codex', resumeAccount: 'saved-account',
    cwd: '/a-stale-folder-that-must-not-be-authority', profileId: 'profile-1', tier: 'astra', effort: 'ultra',
    requestKeys: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] },
    roleBinding: { id: 'worker', agentId: 'saved-node', expectedOrgRevision: 1, expectedRoleRevision: 1 } }
  deps.host.recoverContinuation = async (_request, start) => start(descriptor)
  deps.host.rememberContinuation = (id, defaults) => retained.push({ id, defaults })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:continuations', { action: 'resume', key: 'a'.repeat(64), revision: 7,
    requestKeys: descriptor.requestKeys, treeIdentity: { selfName: 'Current worker', managerName: 'Current controller' } }, window)
  assert.equal(result.sessionId, 'recovered')
  const request = deps.calls.find(row => row.name === 'startSession').args[0]
  assert.equal(request.resumeThreadId, 'native-thread'); assert.equal(request.resumeThreadProvider, 'codex')
  assert.equal(request.effort, 'ultra'); assert.equal(request.tier, 'astra')
  assert.notEqual(request.cwd, descriptor.cwd, 'the current consented profile resolves the working folder')
  assert.ok(bindings.every(row => row.expectedOrgRevision === 9 && row.expectedRoleRevision === 8))
  assert.equal(deps.agentSessions.get('recovered').owner, WINDOW_OWNER)
  assert.equal(deps.calls.filter(row => row.name === 'recordSpawnIntent').length, 1)
  assert.equal(deps.calls.filter(row => row.name === 'recordSpawnOutcome').length, 1)
  assert.equal(retained.length, 1)
  await assert.rejects(surface.run('agent:continuations', { action: 'read' }, elsewhere), { code: PRINCIPAL_REFUSAL })
});

test('a restored process closed after missing terminal evidence retires its exact outer session record', async () => {
  const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
  deps.host.recoverContinuation = async (_request, start, onClosed) => {
    await start({ sessionId: 'observed-only', resumeThreadId: 'native-thread', requestKeys: { threadId: 'node', treeAnchors: ['node'] } })
    assert.ok(deps.agentSessions.has('observed-only'))
    onClosed('observed-only')
    throw Object.assign(new Error('No native terminal evidence'), { code: 'CONTINUATION_TERMINAL_EVIDENCE_MISSING' })
  }
  await assert.rejects(surface.run('agent:continuations', { action: 'resume', key: 'a'.repeat(64), revision: 1,
    requestKeys: { threadId: 'node', treeAnchors: ['node'] }, treeIdentity: { selfName: 'Worker' } }, window), error => {
    assert.equal(error.code, 'CONTINUATION_TERMINAL_EVIDENCE_MISSING')
    assert.equal(error.message, 'CONTINUATION_TERMINAL_EVIDENCE_MISSING')
    assert.doesNotMatch(error.message, /No native terminal evidence/)
    return true
  })
  assert.equal(deps.agentSessions.has('observed-only'), false)
  assert.equal(deps.calls.filter(row => row.name === 'recordSessionEnd').length, 1)
});

test('persistent account retries use the real parser, native-window consent and bounded refusal timing', async () => {
 const at = MAIN.indexOf('function parseAgentStart(value) {'), end = MAIN.indexOf('\n}', at)
 const productionParse = new Function('agentPayload', 'boundedAgentString', 'agentIpcError', 'AGENT_EFFORT_VALUES',
  'MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'MAX_ACCOUNT_NAME_LENGTH',
  MAIN.slice(at, end + 2) + '; return parseAgentStart;')(
  agentPayload, boundedAgentString, agentIpcError, AGENT_EFFORT_VALUES, 128, 32768, 128, 64)
 const request = { sessionId: 'retry-owned', surface: 'fleet-tree', tier: 'claude-fable', effort: 'max',
  accountRetry: { excludeAccounts: ['previous'], recheckAttempt: 4 },
  requestKeys: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] }, treeIdentity: { selfName: 'Worker', managerName: 'Controller' } }
 for (const addition of [{ resumeThreadId: 'original-native' }, { resumeAccount: 'original-account' }, { continueFromAccount: 'previous' },
   { accountRecovery: { recoveryId: 'old-ticket' } }, { accountRetry: { excludeAccounts: Array(33).fill('a'), recheckAttempt: 0 } },
   { accountRetry: { excludeAccounts: [], recheckAttempt: -1 } }, { accountRetry: { excludeAccounts: [], recheckAttempt: 0, home: '/forged' } }]) {
   assert.throws(() => productionParse({ ...request, ...addition }))
 }
 const deps = fakeDeps({ parseAgentStart: productionParse }), surface = createAgentCommandSurface(deps)
 await assert.rejects(surface.run('agent:start', request, { kind: 'relay', owner: 'remote', mayWrite: true, label: 'Remote' }), { code: 'AGENT_MANUAL_ACCOUNT_CONTINUATION_WINDOW_ONLY' })
 assert.equal(deps.calls.filter(row => row.name === 'startSession').length, 0)
 const metadata = { provider: 'claude', account: null, attempts: [], retry: { nextAttemptAt: '2026-09-11T01:00:00Z', resetAt: null } }
 deps.host.startSession = async actual => { assert.deepEqual(actual.accountRetry, request.accountRetry);
   throw Object.assign(fixtureStartRefusal(actual.sessionId, 'ACCOUNT_RECOVERY_NO_ALTERNATE', 'private provider payload'), { accountRetry: metadata }) }
 const result = await surface.run('agent:start', request, window)
 assert.equal(result.ok, false)
 assert.equal(result.code, 'ACCOUNT_RECOVERY_NO_ALTERNATE')
 assert.deepEqual(result.accountRetry, metadata)
 assert.equal(JSON.stringify(result).includes('private provider payload'), false)
 assert.equal(deps.agentSessions.has(request.sessionId), false)
})

test('direction query uses verified host selection and rejects malformed node scope or a relay caller', async () => {
 const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
 const queries = []
 deps.host.continuationEnabled = () => true
 deps.host.continuationDirection = request => { queries.push(request); return { actionable: true, taskIds: ['T4'], reason: 'open-ledger-work' } }
 const request = { action: 'direction', sessionId: 'prior-owned', requestKeys: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] } }
 assert.deepEqual(await surface.run('agent:continuations', request, window), { ok: true, enabled: true, actionable: true, taskIds: ['T4'], reason: 'open-ledger-work' })
 await assert.rejects(surface.run('agent:continuations', request, elsewhere), { code: PRINCIPAL_REFUSAL })
 await assert.rejects(surface.run('agent:continuations', { ...request, requestKeys: { threadId: '', treeAnchors: [] } }, window))
 await assert.rejects(surface.run('agent:continuations', { ...request, sessionId: 'x'.repeat(129) }, window))
 assert.equal(queries.length, 1)
})

test('desktop relay commands preserve exact native ownership and never consume window event delivery', async () => {
  const owner = {}, forwarded = [], invoked = []
  const deps = fakeDeps({ currentRelayOwner: () => owner,
    desktopSessions: {
      list: async principal => { invoked.push(principal); return { ok: true, sessions: [] } },
      tree: async principal => { invoked.push(principal); return { ok: true, desktopTree: { version: 1, computerId: 'this-computer', trees: [], nodes: [] } } },
      transcript: async () => ({ ok: true, entries: [] }),
      send: async () => ({ ok: true }),
      forward: packet => { forwarded.push(packet); return true }, close() {},
    },
  })
  const surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface, 'desktop-paired', window)
  const held = deps.agentSessions.get('desktop-paired')
  assert.equal(held.pairingOwner, owner)
  assert.equal(Object.keys(held).includes('pairingOwner'), false)
  const relay = { kind: 'relay', owner, mayWrite: true, label: 'web (relay)' }
  await surface.run('agent:desktop-sessions', undefined, relay)
  assert.equal(invoked[0], relay)
  const readOnlyRelay = { ...relay, mayWrite: false }
  assert.equal((await surface.run('agent:desktop-tree', undefined, readOnlyRelay)).desktopTree.computerId, 'this-computer')
  assert.equal(invoked[1], readOnlyRelay)
  await assert.rejects(surface.run('agent:desktop-tree', undefined, window), { code: PRINCIPAL_REFUSAL })
  await assert.rejects(surface.run('agent:desktop-sessions', undefined, window), { code: PRINCIPAL_REFUSAL })
  await assert.rejects(surface.run('agent:send', { sessionId: 'desktop-paired', text: 'wrong route' }, relay), { code: 'MC_AGENT_UNKNOWN_SESSION' })
  assert.equal(held.owner, WINDOW_OWNER)
  assert.equal(held.ownerKind, 'window')
  const packet = { sessionId: 'desktop-paired', event: { type: 'assistant_text', text: 'reply' } }
  assert.equal(surface.forwardSessionEvent(packet), false, 'the caller must also send the original packet to its window')
  assert.deepEqual(forwarded, [packet])
})

test('category reset is person-only, uses the installed service, and forwards the exact preview challenge', async () => {
  const calls = []
  const challenge = { kind: 'P', count: 19, promptCount: 4, revision: 23, token: 'a'.repeat(64) }
  const deps = fakeDeps({ requireModule: file => {
    assert.match(file, /ledger-category-reset\.js$/)
    return { preview: async input => { calls.push(input); return { ok: true, ...challenge } },
      confirm: async input => { calls.push(input); return { ok: true, kind: input.kind, count: 19, batchId: 'batch-fixture' } } }
  } })
  const surface = createAgentCommandSurface(deps)
  assert.deepEqual(await surface.run('agent:ledger-reset-preview', { kind: 'P' }, window), { ok: true, ...challenge })
  const request = { kind: 'P', revision: challenge.revision, token: challenge.token }
  assert.equal((await surface.run('agent:ledger-reset-confirm', request, window)).ok, true)
  assert.deepEqual(calls, [{ kind: 'P', actor: 'owner' }, { ...request, actor: 'owner' }])
  assert.ok(!deps.names().includes('getAgentHost'), 'reset does not depend on a running provider')
  for (const operation of ['preview', 'confirm']) {
    const command = 'agent:ledger-reset-' + operation
    for (const principal of [readOnly, { ...window, kind: 'agent' }]) {
      deps.calls.length = 0
      assert.equal((await refusal(surface.run(command, operation === 'preview' ? { kind: 'P' } : request, principal))).code,
        principal.mayWrite ? PRINCIPAL_REFUSAL : READ_ONLY_REFUSAL)
      assert.deepEqual(deps.names(), [], 'refused callers cannot load or mutate the ledger')
    }
  }
})

test('category reset rejects extra fields, invalid kinds and stale challenge shapes before loading the engine', async () => {
  const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
  for (const [operation, payload] of [
    ['preview', { kind: 'Q' }], ['preview', { kind: 'T', actor: 'owner' }], ['preview', { kind: 'T', scope: 'tree' }],
    ['confirm', { kind: 'T', revision: -1, token: 'a'.repeat(64) }],
    ['confirm', { kind: 'T', revision: 1, token: '' }],
    ['confirm', { kind: 'T', revision: 1, token: 'a'.repeat(64), path: '/not-allowed' }],
  ]) {
    assert.equal((await refusal(surface.run('agent:ledger-reset-' + operation, payload, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
    assert.deepEqual(deps.names(), [])
  }
  const missing = createAgentCommandSurface(fakeDeps({ requireModule() { throw new Error('/private/engine/path') } }))
  const result = await missing.run('agent:ledger-reset-preview', { kind: 'R' }, window)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_LEDGER_RESET_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(result), /private/)
  const changed = createAgentCommandSurface(fakeDeps({ requireModule() {
    return { confirm() { throw Object.assign(new Error('/private/store'), { code: 'R_LEDGER_RESET_STALE' }) } }
  } }))
  const stale = await changed.run('agent:ledger-reset-confirm', { kind: 'T', revision: 1, token: 'a'.repeat(64) }, window)
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /Ledger changed.*review the current count/)
  assert.doesNotMatch(JSON.stringify(stale), /private/)
})

for (const principal of [window, { kind: 'relay', owner: { principal: 'workspace-relay' }, mayWrite: true, label: 'web (relay)' }]) {
  test(`start: ${principal.kind} authority refusal offers only observed unconfirmed workspace recovery`, async () => {
    const sourceError = fixtureStartRefusal('workspace-refusal', 'OWNER_HOST_PERMISSION_UNAVAILABLE', 'private owner boundary detail')
    let workspace = { ok: true, available: true, configured: true, chosen: false, roots: ['private suggested folder'] }
    const deps = fakeDeps({ readWorkspaceState: () => workspace })
    deps.host.startSession = async () => { throw sourceError }
    const surface = createAgentCommandSurface(deps)
    const error = await surface.run('agent:start', { sessionId: 'workspace-refusal' }, principal)
    assert.equal(error.ok, false)
    assert.equal(error.code, 'AGENT_START_WORKSPACE_UNCONFIRMED')
    assert.equal(error.reason, error.code, 'only curated code crosses the renderer boundary')
    assert.equal(sourceError.code, 'OWNER_HOST_PERMISSION_UNAVAILABLE', 'native cause remains unchanged')
    assert.equal(deps.agentSessions.size, 0)
    assert.equal(deps.calls.find(call => call.name === 'recordSpawnOutcome').args[3], sourceError.code)
    assert.equal(workspace.chosen, false)
    assert.deepEqual(workspace.roots, ['private suggested folder'])
    workspace = { ...workspace, chosen: true }
    deps.host.startSession = async request => ({ sessionId: request.sessionId })
    assert.equal((await surface.run('agent:start', { sessionId: 'workspace-refusal' }, principal)).sessionId, 'workspace-refusal')
  })
}

for (const state of [undefined, null, [], { ok: false }, { ok: true, available: false },
  { ok: true, available: true, configured: false, chosen: false },
  { ok: true, available: true, configured: true },
  { ok: true, available: true, configured: true, chosen: true },
  { ok: true, available: true, configured: true, chosen: 'false' }]) {
  test(`start: inconclusive or chosen workspace does not rename authority failure: ${JSON.stringify(state)}`, async () => {
    const deps = fakeDeps({ readWorkspaceState: () => state })
    deps.host.startSession = async () => agentIpcError('OWNER_HOST_PERMISSION_UNAVAILABLE', 'private detail')
    assert.equal((await refusal(createAgentCommandSurface(deps).run('agent:start', { sessionId: 'unchanged' }, window))).code,
      'OWNER_HOST_PERMISSION_UNAVAILABLE')
  })
}

test('start: unreadable workspace does not mask original authority failure', async () => {
  const deps = fakeDeps({ readWorkspaceState: () => { throw new Error('private read failure') } })
  deps.host.startSession = async () => agentIpcError('OWNER_HOST_PERMISSION_UNAVAILABLE', 'private detail')
  assert.equal((await refusal(createAgentCommandSurface(deps).run('agent:start', { sessionId: 'unreadable' }, window))).code,
    'OWNER_HOST_PERMISSION_UNAVAILABLE')
})

test('start: an unconfirmed workspace neither blocks an accepted start nor renames other failures', async () => {
  let reads = 0
  const deps = fakeDeps({ readWorkspaceState: () => { reads++; return { ok: true, available: true, configured: true, chosen: false } } })
  const surface = createAgentCommandSurface(deps)
  assert.equal((await surface.run('agent:start', { sessionId: 'accepted' }, window)).sessionId, 'accepted')
  deps.host.startSession = async () => agentIpcError('AGENT_RESOURCE_PRESSURE', 'private detail')
  assert.equal((await refusal(surface.run('agent:start', { sessionId: 'other' }, window))).code, 'AGENT_RESOURCE_PRESSURE')
  assert.equal(reads, 0, 'recovery observation never becomes an admission gate')
})

test('workspace recovery reader is wired in the desktop and remains optional without replacing unknown causes', async () => {
  assert.match(MAIN.slice(MAIN.indexOf('agentCommandSurface = createAgentCommandSurface({')), /\n    readWorkspaceState,\n/)
  assert.throws(() => createAgentCommandSurface(fakeDeps({ readWorkspaceState: true })), /readWorkspaceState must be a function/)
  const deps = fakeDeps()
  deps.host.startSession = async () => agentIpcError('OWNER_HOST_PERMISSION_UNAVAILABLE', 'private detail')
  assert.equal((await refusal(createAgentCommandSurface(deps).run('agent:start', { sessionId: 'no-reader' }, window))).code,
    'OWNER_HOST_PERMISSION_UNAVAILABLE')
})

test('workspace recovery reads current facts after the refused host await', async () => {
  let release, entered, chosen = false
  const waiting = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const deps = fakeDeps({ readWorkspaceState: () => ({ ok: true, available: true, configured: true, chosen }) })
  deps.host.startSession = async () => { entered(); await blocked; agentIpcError('OWNER_HOST_PERMISSION_UNAVAILABLE', 'private detail') }
  const pending = refusal(createAgentCommandSurface(deps).run('agent:start', { sessionId: 'fresh-facts' }, window))
  await waiting
  chosen = true
  release()
  assert.equal((await pending).code, 'OWNER_HOST_PERMISSION_UNAVAILABLE', 'a formerly unchosen folder is not reported after it was confirmed')
})

test('account retry returns the same bounded workspace remedy while retaining native cause in the record', async () => {
  const deps = fakeDeps({
    parseAgentStart: value => ({ ...parseAgentStart(value), accountRetry: true }),
    readWorkspaceState: () => ({ ok: true, available: true, configured: true, chosen: false }),
  })
  deps.host.startSession = async request => { throw fixtureStartRefusal(request.sessionId, 'OWNER_HOST_PERMISSION_UNAVAILABLE', 'private detail') }
  const result = await createAgentCommandSurface(deps).run('agent:start', { sessionId: 'account-retry-workspace' }, window)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_START_WORKSPACE_UNCONFIRMED')
  assert.equal(result.reason, result.code)
  assert.equal(deps.calls.find(call => call.name === 'recordSpawnOutcome').args[3], 'OWNER_HOST_PERMISSION_UNAVAILABLE')
  assert.equal(deps.agentSessions.size, 0)
})

/* THE PAYLOAD THE RENDERER ACTUALLY SENDS, DRIVEN THROUGH THE REAL SURFACE.
 *
 * This is the gate for a defect every other T61 test was blind to, and a hand
 * test found: `agentPayload(value, allowedKeys)` REFUSES any field it was not
 * told about, and `objective` had been left out of the list. `get` and `clear`
 * send two fields and worked; `set` sends three and was refused with
 * MC_AGENT_INVALID_PAYLOAD before the host was reached. The renderer cannot
 * tell that apart from a lost response, so a person typing
 * `/goal <what they want done>` was told "This screen could not confirm the
 * goal was set" while nothing had been set at all -- the whole feature,
 * unreachable from the only surface a person has.
 *
 * Every host-level test passed throughout, because they call host.setGoal()
 * directly. The only thing that catches an allow-list that forgot a field is
 * sending the real shape through the real surface, so that is what this does.
 */
test('agent:goal carries an objective through the surface, and the three operations reach their own host verb', async () => {
  const deps = fakeDeps()
  const surface = createAgentCommandSurface(deps)
  await surface.run('agent:start', { sessionId: 'chat-1', tier: 'luna' }, window)

  /* SET, with the third field. This is the one that was refused. */
  deps.calls.length = 0
  const set = await surface.run('agent:goal',
    { sessionId: 'chat-1', operation: 'set', objective: 'finish the release notes' }, window)
  assert.deepEqual(deps.calls.at(-1),
    { name: 'setGoal', args: [{ sessionId: 'chat-1', objective: 'finish the release notes' }] },
    'the objective must reach the host instead of being refused as an unexpected field')
  assert.equal(set.goal.objective, 'finish the release notes')

  /* GET and CLEAR each reach their OWN verb: an operation that fell through to
     the wrong one would look like it worked from the renderer's side. */
  deps.calls.length = 0
  await surface.run('agent:goal', { sessionId: 'chat-1', operation: 'get' }, window)
  assert.equal(deps.calls.at(-1).name, 'readGoal')
  deps.calls.length = 0
  await surface.run('agent:goal', { sessionId: 'chat-1', operation: 'clear' }, window)
  assert.equal(deps.calls.at(-1).name, 'clearGoal')

  /* An unknown operation refuses by name and touches no verb: defaulting a
     goal write to a read would look like it worked. */
  deps.calls.length = 0
  assert.equal((await refusal(surface.run('agent:goal',
    { sessionId: 'chat-1', operation: 'banana' }, window))).code, 'AGENT_GOAL_OPERATION_UNKNOWN')
  assert.deepEqual(deps.names(), [], 'an unknown operation reached a host verb')

  /* A field nobody allowed is still refused -- the fix widened the list by
     exactly one name and must not have opened it. */
  assert.equal((await refusal(surface.run('agent:goal',
    { sessionId: 'chat-1', operation: 'get', smuggled: 'x' }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')

  /* And it is still fenced to the session's owner, like every other verb. */
  assert.equal((await refusal(surface.run('agent:goal',
    { sessionId: 'chat-1', operation: 'set', objective: 'x' }, otherWindow))).code, 'MC_AGENT_UNKNOWN_SESSION')
})

test('mode receipt refuses changed ownership and arbitrary permission overrides', async () => {
  const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  let settle
  deps.host.setSessionMode = () => new Promise(resolve => { settle = resolve })
  const pending = refusal(surface.run('agent:mode', { sessionId: 'chat-1', modeId: 'plan' }, window))
  await Promise.resolve()
  deps.agentSessions.set('chat-1', { ...deps.agentSessions.get('chat-1') })
  settle({ currentModeId: 'plan', applied: true })
  assert.equal((await pending).code, 'AGENT_MODE_SELECTION_UNCONFIRMED')
  assert.equal((await refusal(surface.run('agent:mode', { sessionId: 'chat-1', modeId: 'plan', sandbox: 'off' }, window))).code, 'MC_AGENT_INVALID_PAYLOAD')
})


function productionResearchStartParser(engineRoot) {
  const first = MAIN.indexOf('function parseResearchStart(value) {')
  const last = MAIN.indexOf('function parseAgentSend(', first)
  assert.ok(first >= 0 && last > first, 'the actual desktop start parser must be present')
  return new Function('agentPayload', 'boundedAgentString', 'agentIpcError', 'require', 'resolveCapabilityRoot', 'randomUUID',
    'const path = require("node:path"); const MAX_SESSION_ID_LENGTH=128, MAX_CWD_LENGTH=32768, MAX_SURFACE_LENGTH=64, MAX_ACCOUNT_NAME_LENGTH=64;'
    + 'const AGENT_EFFORT_VALUES=["none","minimal","low","medium","high","xhigh","max","ultra"];'
    + MAIN.slice(first, last) + '; return parseAgentStart;')(
      agentPayload, boundedAgentString, agentIpcError, require, () => engineRoot, () => 'fixture-id')
}

test('actual desktop parser and command surface refuse unpermitted research before audit or provider work', async () => {
  const { canonicalRootForTests } = await import('../canonical-root.mjs')
  const parser = productionResearchStartParser(canonicalRootForTests({ requireConfigured: true }))
  const research = { mode: 'clean-room', access: 'read-only', prompt: 'Read only this input.', files: [] }
  const deps = fakeDeps({ parseAgentStart: parser })
  const surface = createAgentCommandSurface(deps)
  await assert.rejects(surface.run('agent:start', { sessionId: 'unpermitted-research', research }, window),
    { code: 'RESEARCH_DELEGATION_REFUSED' })
  await assert.rejects(surface.run('agent:start', { sessionId: 'forged-permit', research, researchPermit: { researchAccess: {} } }, window),
    { code: 'MC_AGENT_INVALID_PAYLOAD' })
  await assert.rejects(surface.run('agent:start', { sessionId: 'bad-input', research: { ...research, files: [{ path: '../escape', content: '' }] } }, window),
    { code: 'MC_AGENT_RESEARCH_INVALID' })
  assert.equal(deps.names().includes('recordSpawnIntent'), false)
  assert.equal(deps.names().includes('startSession'), false)
})

test('consumed research permit overrides profile cwd and reaches host as the exact private object', async () => {
  const { canonicalRootForTests } = await import('../canonical-root.mjs')
  const parser = productionResearchStartParser(canonicalRootForTests({ requireConfigured: true }))
  const research = { mode: 'clean-room', access: 'read-only', prompt: 'Only the explicit prompt.', files: [] }
  const access = Object.freeze({ version: 1, mode: 'clean-room', access: 'read-only', root: path.resolve('fixture-clean-room') })
  let checks = 0, continuationCalls = 0
  const permit = Object.freeze({ researchAccess: access, details: {}, assertStart() { checks++ }, cancel() {} })
  const deps = fakeDeps({ parseAgentStart: parser, redeemTreeDelegation(token, request, principal) {
    assert.equal(token, 'one-use'); assert.equal(principal, window)
    return permit
  } })
  deps.host.rememberContinuation = () => { continuationCalls++ }
  deps.host.startSession = async request => {
    assert.equal(request.researchPermit, permit)
    assert.equal(request.delegationPermit, undefined)
    assert.equal(request.cwd, access.root)
    assert.equal(request.delegationToken, undefined)
    assert.equal(Object.keys(request).includes('researchPermit'), false)
    return { sessionId: request.sessionId, threadId: 'thread-research', tier: 'unrestricted' }
  }
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'research-child', profileId: 'parent-profile',
    delegationToken: 'one-use', research }, window)
  assert.equal(checks, 1)
  assert.equal(result.researchRestriction, access)
  const session = deps.agentSessions.get('research-child')
  assert.equal(session.cwd, access.root)
  assert.equal(session.treeDelegationStart, permit, 'failed-start cleanup retains exact ownership')
  assert.equal(session.researchRestriction, access)
  assert.equal(continuationCalls, 0, 'ordinary continuation cannot discard the ceiling')
  await surface.run('agent:close', { sessionId: 'research-child' }, window)
})

test('research permit expiry during audit prevents provider dispatch', async () => {
  const { canonicalRootForTests } = await import('../canonical-root.mjs')
  const parser = productionResearchStartParser(canonicalRootForTests({ requireConfigured: true }))
  let expired = false, release, entered
  const gate = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { entered = resolve })
  const permit = { researchAccess: Object.freeze({ version: 1, mode: 'folder', root: path.resolve('fixture-scope'), access: 'read-only' }),
    assertStart() { if (expired) agentIpcError('RESEARCH_DELEGATION_REFUSED', 'parent changed') }, cancel() {} }
  const deps = fakeDeps({ parseAgentStart: parser, redeemTreeDelegation: () => permit,
    recordSpawnIntent: async () => { entered(); await gate; return { sequence: 1, eventHash: 'test', durable: true, signed: true } } })
  const surface = createAgentCommandSurface(deps)
  const pending = surface.run('agent:start', { sessionId: 'expired-research', delegationToken: 'one-use',
    research: { mode: 'folder', folder: permit.researchAccess.root, access: 'read-only', prompt: 'Read sample.' } }, window)
  const refusal = assert.rejects(pending, { code: 'RESEARCH_DELEGATION_REFUSED' })
  await waiting
  expired = true
  release()
  await refusal
  assert.equal(deps.names().includes('startSession'), false)
  assert.equal(deps.agentSessions.has('expired-research'), false)
})

async function ownerSetupFixture(t, { mismatch = false, cleanupFails = false, auditFails = false } = {}) {
  const fs = require('node:fs')
  const { canonicalRootForTests } = await import('../canonical-root.mjs')
  const engineRoot = canonicalRootForTests({ requireConfigured: true })
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'research-owner-surface-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const access = require(path.join(engineRoot, 'src/lib/research-access.js'))
  const authority = require('../../shell/research-delegation-authority.cjs').createResearchDelegationAuthority({
    readParent: () => { throw new Error('Owner setup cannot borrow a parent') },
    normalizeRequest: require(path.join(engineRoot, 'src/lib/research-delegation-request.js')).normalizeResearchDelegation,
    validateAccess: access.validateResearchAccess, enforceAccess: access.enforceResearchAccess,
    roomsRoot: path.join(root, 'rooms'),
  })
  let held = null
  const deps = fakeDeps({ parseAgentStart: productionResearchStartParser(engineRoot) })
  const admissions = new Map()
  const verified = new WeakSet()
  const first = MAIN.indexOf('function prepareOwnerResearchSetup(request, principal) {')
  const last = MAIN.indexOf('function getTreeDelegationAuthority()', first)
  assert.ok(first >= 0 && last > first)
  const injected = { treeSpawnError: (code, message) => Object.assign(new Error(message), { code }),
    treeOwnerKey: principal => {
      if (principal.kind !== 'window' || principal.owner !== window.owner) throw new Error('wrong owner')
      return 'owner-key'
    },
    getResearchDelegationAuthority: () => authority, agentSessions: deps.agentSessions,
    agentHost: deps.host, researchNodeAdmissions: admissions, verifiedTreeDelegations: verified }
  const prepare = new Function(...Object.keys(injected), MAIN.slice(first, last)
    + ';return prepareOwnerResearchSetup;')(...Object.values(injected))
  deps.prepareResearchSetup = (request, principal) => {
    held = prepare(request, principal)
    return held
  }
  const audit = deps.recordSpawnIntent
  deps.recordSpawnIntent = async request => {
    assert.equal(request.cwd, held.researchAccess.root)
    assert.equal(Object.keys(request).includes('researchPermit'), false)
    assert.equal(request.researchSetup, undefined)
    if (auditFails) agentIpcError('AUDIT_REFUSED', 'fixture audit refused')
    return audit(request)
  }
  deps.host.readTreeParent = sessionId => ({ sessionId, nodeId: 'research-node',
    treeId: 'research-tree', treeAnchors: ['research-tree', 'research-node'], modelTier: 'luna',
    cwd: mismatch ? root : held.researchAccess.root, researchAccess: held.researchAccess })
  const close = deps.host.closeSession
  deps.host.closeSession = async request => {
    assert.equal(typeof request, 'object')
    assert.equal(request.sessionId, 'owner-research')
    if (cleanupFails) agentIpcError('AGENT_SESSION_CLEANUP_FAILED', 'fixture close refused')
    return close(request)
  }
  const request = { sessionId: 'owner-research', surface: 'research-experiment', tier: 'luna',
    requestKeys: { threadId: 'research-node', treeAnchors: ['research-tree', 'research-node'] },
    researchSetup: true,
    research: { mode: 'clean-room', access: 'read-only', prompt: 'Read supplied input only.',
      files: [{ path: 'inputs/example.txt', content: 'explicit input' }] } }
  return { deps, request, root, admissions, verified, get permit() { return held },
    rooms: () => fs.existsSync(path.join(root, 'rooms')) ? fs.readdirSync(path.join(root, 'rooms')) : [],
    run: () => createAgentCommandSurface(deps).run('agent:start', request, window) }
}

test('actual parser rejects mixed or invalid owner setup without audit or room creation', async t => {
  const flow = await ownerSetupFixture(t)
  const surface = createAgentCommandSurface(flow.deps)
  for (const overrides of [
    { researchSetup: false }, { researchSetup: 'true' }, { surface: 'chat' },
    { research: undefined }, { delegationToken: 'child-token' }, { resumeThreadId: 'native-thread' },
    { accountRetry: true }, { boundedWork: {} }, { editorForkReceipt: 'import-receipt' },
  ]) {
    await assert.rejects(surface.run('agent:start', { ...flow.request, ...overrides }, window))
  }
  assert.equal(flow.permit, null)
  assert.deepEqual(flow.rooms(), [])
  assert.equal(flow.deps.names().includes('recordSpawnIntent'), false)
  assert.equal(flow.deps.names().includes('startSession'), false)
})

test('research owner setup refuses relay before room preparation or audit', async t => {
  const flow = await ownerSetupFixture(t)
  await assert.rejects(createAgentCommandSurface(flow.deps).run('agent:start', flow.request,
    { kind: 'relay', owner: { principal: 'remote-owner' }, mayWrite: true, label: 'remote owner' }), { code: 'RESEARCH_SETUP_WINDOW_ONLY' })
  assert.equal(flow.permit, null)
  assert.deepEqual(flow.rooms(), [])
  assert.equal(flow.deps.names().includes('recordSpawnIntent'), false)
})

test('owner checkbox reaches real authority and main receipt verification; successful inputs remain reviewable', async t => {
  const flow = await ownerSetupFixture(t)
  const result = await flow.run()
  const fs = require('node:fs')
  assert.equal(result.researchRestriction, flow.permit.researchAccess)
  assert.equal(fs.readFileSync(path.join(result.researchRestriction.root, 'inputs/example.txt'), 'utf8'), 'explicit input')
  assert.equal(flow.admissions.get('research-node').researchAccess, result.researchRestriction)
  assert.ok(flow.verified.has(flow.deps.agentSessions.get('owner-research')))
  assert.throws(() => flow.permit.assertStart(), { code: 'RESEARCH_DELEGATION_REFUSED' })
  const sent = flow.deps.calls.find(call => call.name === 'startSession').args[0]
  assert.equal(sent.cwd, result.researchRestriction.root)
  assert.equal(sent.researchPermit, flow.permit)
  assert.deepEqual(flow.rooms(), [path.basename(result.researchRestriction.root)])
  await createAgentCommandSurface(flow.deps).run('agent:close', { sessionId: 'owner-research' }, window)
  assert.equal(fs.existsSync(result.researchRestriction.root), true, 'successful room is retained after Stop')
})

test('owner setup audit refusal removes its unused room without provider startup', async t => {
  const flow = await ownerSetupFixture(t, { auditFails: true })
  await assert.rejects(flow.run(), { code: 'AUDIT_REFUSED' })
  assert.deepEqual(flow.rooms(), [])
  assert.equal(flow.deps.names().includes('startSession'), false)
  assert.equal(flow.deps.agentSessions.size, 0)
})

test('mismatched research receipt closes the created session before removing its room', async t => {
  const flow = await ownerSetupFixture(t, { mismatch: true })
  await assert.rejects(flow.run(), { code: 'RESEARCH_DELEGATION_REFUSED' })
  assert.equal(flow.deps.names().includes('closeSession'), true)
  assert.deepEqual(flow.rooms(), [])
  assert.equal(flow.deps.agentSessions.size, 0)
  assert.equal(flow.admissions.size, 0)
})

test('unconfirmed owner research cleanup retains inputs and the session close handle', async t => {
  const flow = await ownerSetupFixture(t, { mismatch: true, cleanupFails: true })
  await assert.rejects(flow.run(), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
  assert.equal(flow.rooms().length, 1)
  assert.equal(flow.deps.agentSessions.get('owner-research').state, 'close-failed')
  assert.throws(() => flow.permit.assertStart(), { code: 'RESEARCH_DELEGATION_REFUSED' })
})

test('research cleanup requires a closed receipt for the exact started session', async t => {
  for (const receipt of [undefined, { closed: false, sessionId: 'owner-research' }, { closed: true, sessionId: 'another-session' }]) {
    const flow = await ownerSetupFixture(t, { mismatch: true })
    flow.deps.host.closeSession = async () => receipt
    await assert.rejects(flow.run(), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
    assert.equal(flow.rooms().length, 1, 'an unproved close must retain the research inputs')
    assert.equal(flow.deps.agentSessions.get('owner-research').state, 'close-failed')
  }
})

test('an unproved research host-start failure retains both inputs and session custody', async t => {
  const flow = await ownerSetupFixture(t)
  flow.deps.host.startSession = async () => { throw Object.assign(new Error('unproved provider start'), { code: 'PROVIDER_START_FAILED' }) }
  await assert.rejects(flow.run(), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
  assert.equal(flow.rooms().length, 1)
  assert.equal(flow.deps.agentSessions.get('owner-research').state, 'close-failed')
})

test('automatic send command forces automatic origin through tracked delivery', async () => {
  const deps = fakeDeps(), surface = createAgentCommandSurface(deps)
  await startedSession(deps, surface)
  deps.calls.length = 0
  await surface.run('agent:send-automatic', { sessionId: 'chat-1', text: 'Continue the pending work.' }, window)
  assert.deepEqual(deps.calls.find(call => call.name === 'sendTurnTracked').args, [{
    sessionId: 'chat-1', text: 'Continue the pending work.', origin: 'automatic',
  }])
  assert.equal(deps.names().includes('sendTurn'), false)
})


test('Basic actual recorder admission reaches engine availability and retains post-detection refusal', async () => {
  const vm = require('node:vm')
  const operation = require(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/operation-audit.js'))
  let enabled = false, opened = 0
  const context = { CAPABILITY_STATE_ROOT: '/test',
    captureAuditPolicy: () => ({ ok: true, operation, decision: operation.capturePolicy({ loadSettings: () => ({ values: { 'audit.enabled': enabled }, provenance: { 'audit.enabled': { source: 'user' } } }) }) }),
    getSpawnRecorder() { opened++; return { availability: () => ({ ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' }) } } }
  const source = MAIN.match(/function spawnRecordAvailability\([^]*?\n\}/)[0]
  const spawnRecordAvailability = vm.runInNewContext(`${source}; spawnRecordAvailability`, context)
  const direct = fakeDeps({ spawnRecordAvailability })
  assert.equal((await createAgentCommandSurface(direct).run('agent:availability', {}, window)).ok, true)
  assert.ok(direct.names().includes('engineAvailability'))
  let engineCalls = 0
  const local = fakeDeps({ spawnRecordAvailability,
    detectLocal: async () => ({ ok: true, ready: true }),
    engineAvailability: options => { engineCalls++; return options.localRuntime ? { ok: false, code: 'AGENT_CONFINEMENT_SIGNED_OUT' } : { ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' } } })
  assert.equal((await createAgentCommandSurface(local).run('agent:availability', {}, window)).code, 'AGENT_CONFINEMENT_SIGNED_OUT')
  assert.equal(engineCalls, 2)
  assert.equal(opened, 0)
  local.detectLocal = async () => { enabled = true; return { ok: true, ready: true } }
  assert.equal((await createAgentCommandSurface(local).run('agent:availability', {}, window)).code, 'SPAWN_RECORD_UNAVAILABLE')
  assert.equal(engineCalls, 3)
  assert.equal(opened, 1)
})


test('Basic and audited starts bind usage before provider events without reading settings per packet', async () => {
  const vm = require('node:vm')
  const { turnUsageFrom, usageLabel } = require('../../shell/usage-record.cjs')
  const operation = require(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/operation-audit.js'))
  for (const required of [false, true]) {
    const writes = []
    let policyReads = 0
    const writer = vm.runInNewContext(`${MAIN.match(/function noteAgentTurnUsageImpl\([^]*?\n\}/)[0]}; noteAgentTurnUsageImpl`, {
      captureAuditPolicy() { policyReads++; throw Error('stream packets must not resolve policy') },
      getUsageRecorder: () => ({ recordTurnAsync: async value => { writes.push(value) } }),
      turnUsageFrom, usageLabel, turnFailureSentence: () => null, MAX_PENDING_TURN_USAGE: 20,
    })
    const deps = fakeDeps({ recordSpawnIntent: async request => required
      ? { sequence: 7, eventHash: 'a'.repeat(64), principal: 'account:original' }
      : { ...operation.skippedStatus('controller.agent.launch', request.sessionId), principal: 'account:original' } })
    deps.host.startSession = async request => {
      const session = deps.agentSessions.get(request.sessionId)
      assert.equal(session.usageAuditRequired, required, 'policy is bound before first provider event')
      for (let index = 0; index < 100; index++) writer(session, { sessionId: request.sessionId, event: { type: 'text', text: 'chunk' } })
      writer(session, { sessionId: request.sessionId, event: { type: 'usage', turnId: 'turn-1', usage: { totalTokens: 15 } } })
      // Account/settings changes cannot replace the admitted operation policy.
      deps.recordSpawnIntent = async () => { throw Error('later configuration is separate') }
      writer(session, { sessionId: request.sessionId, event: { type: 'turn_completed', turnId: 'wrong-turn' } })
      writer(session, { sessionId: request.sessionId, event: { type: 'turn_completed', turnId: 'turn-1' } })
      writer(session, { sessionId: request.sessionId, event: { type: 'turn_completed', turnId: 'turn-1' } })
      return { sessionId: request.sessionId, threadId: 'thread-1' }
    }
    const request = { sessionId: `usage-${required}`, tier: 'luna' }
    const answer = await createAgentCommandSurface(deps).run('agent:start', request, window)
    assert.equal(answer.sessionId, request.sessionId)
    assert.equal(writes.length, required ? 1 : 0)
    assert.equal(policyReads, 0)
    if (required) { assert.equal(writes[0].principal, 'account:original'); assert.equal(writes[0].turnId, 'turn-1') }
  }
})

test('unknown audit settings stop actual native start admission while absent and disabled settings start normally', async () => {
  const vm = require('node:vm'), fs = require('node:fs')
  const canonical = require('../../shell/canonical-audit.cjs')
  const engine = canonicalRootForTests({ requireConfigured: true })
  const operation = require(path.join(engine, 'src/lib/operation-audit.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'start-audit-policy-'))
  const valuesPath = path.join(root, 'settings.json')
  let signing = 0
  const options = { stateRoot: root, root: engine, valuesPath, fresh: true, env: {},
    load: () => ({ operationAudit: operation, verify() { throw Error('No history'); },
      requireRecord() { signing++; throw Error('No signing'); } }) }
  const write = value => fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values: { 'audit.enabled': value },
    provenance: { 'audit.enabled': { source: 'user' } } }))
  const captures = []
  const source = MAIN.match(/async function recordSpawnIntent\([^]*?\n\}/)[0]
  const recordSpawnIntent = vm.runInNewContext(source + '; recordSpawnIntent', {
    CAPABILITY_STATE_ROOT: root, captureAuditPolicy: () => { const result = canonical.captureAuditPolicy(options); captures.push(result); return result },
    accountPrincipal: () => 'test-account', agentIpcError,
    sessionStartRefusalSentence: result => result.code + ': ' + result.reason,
    recordCanonical() { signing++; throw Error('No canonical writer'); },
    getSpawnRecorder() { signing++; throw Error('No local signer'); }
  })
  const start = async id => {
    const deps = fakeDeps({ recordSpawnIntent }), surface = createAgentCommandSurface(deps)
    const result = await surface.run('agent:start', { sessionId: id, tier: 'luna' }, window)
    assert.equal(deps.names().filter(name => name === 'startSession').length, 1)
    assert.equal(operation.isNotRequired(result.audit, 'controller.agent.launch', id), true)
  }
  await start('fresh-basic')
  write(false); await start('saved-basic')
  for (const mode of ['malformed', 'rejected-master', 'unreadable']) {
    if (mode === 'malformed') fs.writeFileSync(valuesPath, '{bad-json')
    if (mode === 'rejected-master') write('sometimes')
    if (mode === 'unreadable') options.valuesPath = root
    const deps = fakeDeps({ recordSpawnIntent }), surface = createAgentCommandSurface(deps)
    await assert.rejects(surface.run('agent:start', { sessionId: 'refused-' + mode, tier: 'luna' }, window),
      error => error.code === 'MC_AGENT_RECORD_UNAVAILABLE' && error.message === 'MC_AGENT_RECORD_UNAVAILABLE')
    assert.equal(captures.at(-1).code, 'AUDIT_POLICY_INVALID', 'the real capture refuses; IPC preserves its established safe outer code')
    for (const effect of ['getAgentHost', 'startSession', 'bindAgentOwner', 'recordSpawnOutcome'])
      assert.equal(deps.names().includes(effect), false, mode + ':' + effect)
    assert.equal(deps.agentSessions.size, 0)
  }
  assert.equal(signing, 0)
  canonical.resetForTests()
  // Retained settings fixture: no filesystem cleanup is registered.
})
