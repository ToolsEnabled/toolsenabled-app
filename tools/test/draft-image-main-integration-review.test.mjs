import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { useStartConsent } from './lib/start-consent-fixture.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const mainRequire = createRequire(path.join(root, 'shell/main.cjs'))
const main = readFileSync(path.join(root, 'shell/main.cjs'), 'utf8')
const ast = parseAst(main)
function declaration(name) {
  const node = ast.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name)
  assert.ok(node, 'actual main function: ' + name)
  return main.slice(node.start, node.end)
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit)
    else if (value && typeof value === 'object') walk(value, visit)
  }
}
const functionNames = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentStart',
  'parseAgentSessionCommand', 'parseAgentPasteAttachment', 'getImageOwnerContext', 'readImageOwnerContext',
  'accountPrincipal', 'invalidateImageDrafts', 'invalidateEndedRecovery', 'verifiedDraftComputerId', 'registerImageDraft',
  'imageDraftRecord', 'runImageDraftStart', 'pasteImageDraft', 'runImageQueue', 'readSavedFleetTrees', 'getEndedSessionRecovery',
  'rememberEndedRecovery', 'registerEndedRecovery', 'runEndedRecoveryStart']
const constantNames = ['MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH',
  'MAX_TURN_TEXT_LENGTH', 'AGENT_EFFORT_VALUES', 'PASTE_IMAGE_MIME_EXTENSIONS',
  'MAX_PASTE_IMAGE_BYTES', 'MAX_PASTE_IMAGE_DATA_LENGTH', 'imageOwnerContext',
  'imageOwnerSubscribers', 'imageDraftRecords', 'imageDraftStarts', 'imageDraftWindows']
const declarations = ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node =>
  node.declarations.filter(item => constantNames.includes(item.id.name))
    .map(item => node.kind + ' ' + main.slice(item.start, item.end) + ';')).join('\n')
const startRegistration = ast.body.find(node => node.type === 'ExpressionStatement'
  && node.expression?.callee?.object?.name === 'ipcMain' && node.expression.arguments?.[0]?.value === 'mc-agent:start')
assert.ok(startRegistration)
const startCallback = startRegistration.expression.arguments[1]
const startSource = main.slice(startCallback.start, startCallback.end)
let beforeHostNode
walk(ast, node => { if (node.type === 'Property' && node.key?.name === 'beforeHostStart') beforeHostNode = node.value })
assert.ok(beforeHostNode)
const beforeHostSource = 'function' + main.slice(beforeHostNode.start, beforeHostNode.end)
let sessionCreatedNode
walk(ast, node => { if (node.type === 'Property' && node.key?.name === 'sessionCreated') sessionCreatedNode = node.value })
assert.ok(sessionCreatedNode)
const sessionCreatedSource = 'function' + main.slice(sessionCreatedNode.start, sessionCreatedNode.end)
let eventCallback
walk(ast, node => {
  if (node.type === 'CallExpression' && node.callee?.object?.name === 'host'
    && node.callee.property?.name === 'onEvent') eventCallback = node.arguments[0]
})
assert.ok(eventCallback)
const eventSource = main.slice(eventCallback.start, eventCallback.end)
const surfaceTest = readFileSync(path.join(root, 'tools/test/agent-command-surface.test.mjs'), 'utf8')
const surfaceAst = parseAst(surfaceTest)
const helperNames = ['fakeDeps', 'agentIpcError', 'agentPayload', 'boundedAgentString',
  'rendererSafeAgentError', 'parseAgentStart', 'parseAgentSend', 'parseAgentSessionCommand', 'parseAgentPasteAttachment']
const helperFunctions = surfaceAst.body.filter(node => node.type === 'FunctionDeclaration' && helperNames.includes(node.id.name))
  .map(node => surfaceTest.slice(node.start, node.end)).join('\n')
const helperConstants = surfaceAst.body.filter(node => node.type === 'VariableDeclaration').flatMap(node =>
  node.declarations.filter(item => ['MAX_SESSION_ID_LENGTH', 'AGENT_EFFORT_VALUES',
    'PASTE_IMAGE_MIME_EXTENSIONS', 'MAX_PASTE_IMAGE_BYTES', 'MAX_PASTE_IMAGE_DATA_LENGTH'].includes(item.id.name))
    .map(item => node.kind + ' ' + surfaceTest.slice(item.start, item.end) + ';')).join('\n')
const fakeDeps = new Function('require', helperConstants + '\n' + helperFunctions + ';return fakeDeps')(require)
const { createAgentCommandSurface } = require('../../shell/agent-command-surface.cjs')
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const tracked = ['shell/main.cjs', 'shell/agent-command-surface.cjs', 'shell/agent-host.cjs',
  'shell/draft-image-coordinator.cjs', 'shell/draft-image-authority.cjs', 'shell/image-owner-context.cjs',
  'shell/node-transcript-capture.cjs', 'shell/node-transcript-store.cjs', 'shell/image-retention-service.cjs',
  'shell/durable-image-custody.cjs', 'shell/image-outbox.cjs', 'shell/provider-image-support.cjs',
  'src/tree-workspace.js', 'tools/test/agent-command-surface.test.mjs',
  'tools/test/image-retention-ipc-review.test.mjs', 'tools/test/draft-image-main-integration-review.test.mjs']
const hashes = () => Object.fromEntries(tracked.map(file => [file,
  createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes()
console.log('DEPENDENCIES_BEFORE ' + JSON.stringify(before))
test.after(() => { const after = hashes(); console.log('DEPENDENCIES_AFTER ' + JSON.stringify(after)); assert.deepEqual(after, before) })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function seatIdentity() {
  const source = readFileSync(path.join(root, 'src/tree-workspace.js'), 'utf8')
  let method
  walk(parseAst(source), node => { if (node.type === 'MethodDefinition' && node.key?.name === 'openStandalone') method = node.value })
  assert.ok(method)
  let mounted
  const open = new Function('crypto', 'el', 'mountStandaloneAgent', 'standalonePlaced',
    'return async function(start)' + source.slice(method.body.start, method.body.end))(
    { randomUUID }, () => ({}), (panel, options) => { mounted = options; return { focus() {} } }, () => {})
  await open.call({ graph: { editMode: false, chatTrack: { appendChild() {} }, standaloneAgent: {} },
    standalone: new Map(), showPicker() {}, sync() {} }, { tier: 'luna' })
  return mounted.id
}
function png() {
  const source = readFileSync(path.join(root, 'tools/test/image-retention-ipc-review.test.mjs'), 'utf8')
  const node = parseAst(source).body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'image')
  return new Function('deflateSync', 'return (' + source.slice(node.start, node.end) + ')')(require('node:zlib').deflateSync)([255, 0, 0])
}
async function setup(t) {
  const temp = realpathSync(process.env.T545_REVIEW_TEMP)
  const scratch = mkdtempSync(path.join(temp, 't589-draft-main-'))
  const relative = path.relative(temp, realpathSync(scratch))
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  const state = { nativeCalls: 0, sends: 0, nativeFailure: false, confinementFailure: false, metadataMissing: false,
    hostFailure: false, waitHost: null, enteredHost: null, waitSave: null, enteredSave: null,
    account: { principal: 'fixture-product-principal', signedIn: false },
    starts: [], turns: [], children: [], queueCalls: [], events: new Set(), ownerListeners: new Set(),
    graph: null, orgRevision: 1, saves: 0, publications: [] }
  const nodeId = await seatIdentity(), computerId = 'this-computer'
  state.seat = { id: nodeId, nodeId, role: 'worker', enabled: true }
  const startNative = async options => {
    state.nativeCalls++
    if (state.nativeFailure) throw Object.assign(new Error('inert native start failure'), { code: 'INERT_NATIVE_START_FAILED' })
    state.starts.push(options)
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
    state.children.push(child)
    return { threadId: options.threadId || 'thread-' + state.nativeCalls,
      ...(options.threadId ? { resumed: { turns: [], turnCount: 0 } } : {}),
      adapter: { transport: { child },
        sendTurn: async request => {
          state.sends++; state.turns.push(request)
          if (state.sendFailure) throw Object.assign(new Error('inert send unknown'), { code: 'AGENT_SESSION_FAILED' })
          return { turnId: 'inert-turn-' + state.sends }
        },
        interrupt: async () => {}, answerApproval() {} }, close() {} }
  }
  t.mock.method(engine, 'startCodexSession', startNative)
  t.mock.method(engine, 'resumeCodexSession', startNative)
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: root, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => {
      if (state.confinementFailure) {
        throw Object.assign(new Error('inert confinement planner failure'), { code: 'INERT_CONFINEMENT_FAILURE' })
      }
      return { ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }
    } })
  const metadataHost = { ...host, sessionTranscriptMetadata: id => state.metadataMissing ? null : host.sessionTranscriptMetadata(id) }
  const store = createNodeTranscriptStore({ directory: scratch })
  const capture = createNodeTranscriptCapture({ store, sessionMetadata: id => metadataHost.sessionTranscriptMetadata(id) })
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    send: (channel, value) => {
      state.publications.push({ channel, value })
      if (channel === 'agent-event') for (const listener of state.events) listener(value)
      else for (const listener of state.ownerListeners) listener(value)
    } })
  const principal = { kind: 'window', owner, mayWrite: true, label: 'inert application window' }
  let surface, api
  const deps = fakeDeps({
    currentAgentHost: () => host,
    getAgentHost: async () => {
      state.enteredHost?.resolve()
      if (state.waitHost) await state.waitHost.promise
      if (state.hostFailure) throw Object.assign(new Error('inert pre-host failure'), { code: 'INERT_PREHOST_FAILURE' })
      return host
    },
    chosenWorkspaceCwd: () => root, ensureWorkspaceRoot: () => root,
    recordSpawnIntent: () => ({ sequence: 1, durable: true, signed: true, principal: state.account.principal }),
    recordTranscriptBinding: request => capture.bind(request),
  })
  const env = {
    endedSessionRecovery: null, endedRecoverySources: new Map(), endedRecoveryRecords: new Map(), endedRecoveryStarts: new Map(),
    savedDraftGraphReader: await require('../../shell/saved-draft-graph-reader.cjs').loadSavedDraftGraphReader({
      readRecord: key => key === 'mc.fleet.trees.v1:' + computerId ? JSON.stringify(state.graph) : null,
    }),
    require: mainRequire, path, randomUUID, SHELL_PROFILE_FENCE: root, UNAUTHENTICATED_PRINCIPAL: 'unauthed',
    getAccountStore: () => ({ current: () => state.account, principal: () => state.account.principal }),
    agentSessions: deps.agentSessions, agentHost: metadataHost, transcriptCapture: capture,
    agentOrgRecord: { read: () => ({ ok: true, org: { revision: state.orgRevision, agents: [state.seat] } }) },
    rendererPrefs: { snapshot: () => ({ values: { ['mc.fleet.trees.v1:' + computerId]: JSON.stringify(state.graph) } }) },
    getAgentCommandSurface: () => surface,
    WORKSPACE_ROOT: root, AGENT_EVENT_CHANNEL: 'agent-event',
    bindSessionChangePaths: packet => packet, mainLagMonitor: { note: (name, action) => action() },
    recordSessionEnd: deps.recordSessionEnd, noteAgentTurnUsage() {}, noteAgentTurnCompleted() {},
    ownedByThisWindow: () => false, noteAgentNotification() {},
    assertTrustedAgentSender: event => assert.equal(event.sender, owner),
    windowPrincipal: () => principal,
    app: { getPath: () => scratch },
    resolveCapabilityRoot: () => process.env.T545_ENGINE_ROOT,
    savePasteAttachmentToDisk: async (mime, bytes) => {
      state.enteredSave?.resolve()
      if (state.waitSave) await state.waitSave.promise
      const savedPath = path.join(scratch, 'saved-' + (++state.saves) + '.png')
      writeFileSync(savedPath, bytes, { flag: 'wx' })
      return { path: savedPath, mime }
    },
  }
  api = new Function(...Object.keys(env), declarations + '\n' + functionNames.map(declaration).join('\n')
    + ';return {getImageOwnerContext,readImageOwnerContext,runImageQueue,runImageDraftStart,parseAgentStart,'
    + 'parseAgentPasteAttachment,beforeHostStart:' + beforeHostSource + ',sessionCreated:' + sessionCreatedSource
    + ',startIpc:(' + startSource + '),event:(' + eventSource + ')}')(...Object.values(env))
  deps.parseAgentStart = api.parseAgentStart
  deps.parseAgentPasteAttachment = api.parseAgentPasteAttachment
  deps.beforeHostStart = api.beforeHostStart
  deps.sessionCreated = api.sessionCreated
  deps.imageQueue = request => { state.queueCalls.push(request); return api.runImageQueue(request, principal) }
  deps.savePasteAttachment = env.savePasteAttachmentToDisk
  const unsubscribe = host.onEvent(api.event)
  t.after(unsubscribe)
  surface = createAgentCommandSurface(deps)
  const context = () => api.readImageOwnerContext(principal)
  const queue = request => surface.run('agent:image-queue', { ownerContext: context(), ...request }, principal)
  const register = (kind = 'standalone', id = nodeId) => queue({ operation: 'draft-register', kind, computerId, nodeId: id })
  const start = receipt => api.startIpc({ sender: owner }, { draftId: receipt.draftId, sessionId: receipt.sessionId,
    ownerContext: receipt.ownerContext, tier: 'luna', surface: 'standalone-agent' })
  const paste = receipt => queue({ operation: 'draft-paste', draftId: receipt.draftId,
    ownerContext: receipt.ownerContext, mime: 'image/png', data: png().toString('base64') })
  t.after(async () => {
    try {
      if (state.expectUncertainCleanup) await assert.rejects(host.closeAll(), AggregateError)
      else await host.closeAll()
    } finally { await capture.shutdown() }
  })
  return { state, api, deps, host, capture, store, principal, owner, context, queue, register, start, paste, computerId, nodeId, surface }
}

test('initial owner publication allows later draft registration and actual start/adopt/opaque retain', async t => {
  const f = await setup(t)
  const initial = f.context()
  assert.equal(f.state.publications.length, 1)
  assert.equal(f.state.publications[0].value, initial)
  const registered = await f.register()
  assert.equal(registered.ok, true)
  const receipt = registered.result
  const pasted = await f.paste(receipt)
  assert.equal(pasted.ok, true)
  assert.deepEqual(Object.keys(pasted.result).sort(), ['draftId', 'imageId'])
  const started = await f.start(receipt)
  assert.equal(started.sessionId, receipt.sessionId)
  assert.equal(f.state.nativeCalls, 1)
  assert.equal(f.deps.agentSessions.get(receipt.sessionId).state, 'ready')
  const imageIds = [pasted.result.imageId]
  const adopted = await f.queue({ operation: 'draft-adopt', draftId: receipt.draftId, sessionId: receipt.sessionId, imageIds })
  assert.equal(adopted.ok, true)
  assert.equal(adopted.result.automaticSend, false)
  assert.deepEqual(f.capture.bindingFor(receipt.sessionId), { computerId: f.computerId, nodeId: f.nodeId })
  const retained = await f.queue({ operation: 'draft-retain', draftId: receipt.draftId,
    sessionId: receipt.sessionId, imageIds, operationId: randomUUID() })
  assert.equal(retained.ok, true)
  assert.equal(f.state.sends, 0)
  assert.equal(JSON.stringify([receipt, pasted, adopted, retained]).includes('saved-1.png'), false)
})

test('paste awaiting a save cannot publish an image handle after owner epoch changes', async t => {
  const f = await setup(t), receipt = (await f.register()).result
  f.state.waitSave = deferred(); f.state.enteredSave = deferred()
  const saving = f.paste(receipt)
  await f.state.enteredSave.promise
  f.state.account = { principal: 'next-product-principal', signedIn: false }
  f.context()
  f.state.waitSave.resolve()
  const stale = await saving
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'IMAGE_CUSTODY_REPICK_REQUIRED')
  const retry = await f.paste(receipt)
  assert.equal(retry.ok, false)
  assert.equal(retry.code, 'IMAGE_OWNER_CHANGED')
  assert.equal(f.state.nativeCalls, 0)
})

test('missing metadata after real ready start never releases a false not-started retry', async t => {
  const f = await setup(t), receipt = (await f.register()).result
  f.state.metadataMissing = true
  await assert.rejects(f.start(receipt))
  assert.equal(f.state.nativeCalls, 1)
  assert.equal(f.deps.agentSessions.get(receipt.sessionId).state, 'ready')
  await assert.rejects(f.start(receipt))
  assert.equal(f.state.nativeCalls, 1)
})

test('actual pre-host getter failure releases the same reservation for one later start', async t => {
  const f = await setup(t), receipt = (await f.register()).result
  f.state.hostFailure = true
  await assert.rejects(f.start(receipt))
  assert.equal(f.state.nativeCalls, 0)
  f.state.hostFailure = false
  const result = await f.start(receipt)
  assert.equal(result.sessionId, receipt.sessionId)
  assert.equal(f.state.nativeCalls, 1)
})

test('returned host pre-engine validation refusal releases the draft reservation for one later start', async t => {
  const f = await setup(t), receipt = (await f.register()).result
  f.state.confinementFailure = true
  const refused = await f.start(receipt)
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.startOutcome, {
    requestSessionId: receipt.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none',
  })
  assert.equal(f.state.nativeCalls, 0)
  f.state.confinementFailure = false
  const result = await f.start(receipt)
  assert.equal(result.sessionId, receipt.sessionId)
  assert.equal(f.state.nativeCalls, 1)
})

test('native start invocation followed by failure retains uncertain custody and refuses another start', async t => {
  const f = await setup(t), receipt = (await f.register()).result
  f.state.nativeFailure = true
  f.state.expectUncertainCleanup = true
  const failed = await f.start(receipt)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'INERT_NATIVE_START_FAILED')
  assert.deepEqual(failed.startOutcome, {
    requestSessionId: receipt.sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
  })
  assert.equal(f.deps.agentSessions.get(receipt.sessionId).state, 'close-failed')
  assert.equal(f.state.nativeCalls, 1)
  f.state.nativeFailure = false
  await assert.rejects(f.start(receipt))
  assert.equal(f.state.nativeCalls, 1)
})

test('owner or canonical org change while awaiting host prevents native launch', async t => {
  for (const kind of ['owner', 'org']) {
    await t.test(kind, async t => {
      const f = await setup(t), receipt = (await f.register()).result
      f.state.waitHost = deferred(); f.state.enteredHost = deferred()
      const pending = f.start(receipt)
      const rejected = assert.rejects(pending)
      await f.state.enteredHost.promise
      if (kind === 'owner') {
        f.state.account = { principal: 'next-product-principal', signedIn: false }
        f.context()
      } else f.state.orgRevision++
      f.state.waitHost.resolve()
      await rejected
      assert.equal(f.state.nativeCalls, 0)
    })
  }
})

test('main saved-graph callback rejects a valid-looking draft inside malformed whole canvas', async t => {
  const f = await setup(t)
  f.state.graph = { version: 999, computerId: f.computerId,
    trees: [{ id: 'tree-a', createdAt: 'created', updatedAt: 'updated' }],
    nodes: [{ id: 'draft-a', treeId: 'tree-a', parentId: null, role: '', createdAt: 'created',
      updatedAt: 'updated', status: 'draft', sessionId: null, message: '' }] }
  const refused = await f.register('tree', 'draft-a')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'IMAGE_CUSTODY_REPICK_REQUIRED')
  assert.equal(f.state.nativeCalls, 0)
})


async function mountRecovery(t, { beforeEnd = null } = {}) {
  const f = await setup(t)
  const dom = installDomStandIn()
  useStartConsent(t)
  let dispose
  t.after(() => { dispose?.(); dom.restore() })
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  let control
  const bridge = {
    availability: async () => ({ ok: true }),
    ownerContext: async () => f.context(),
    onOwnerContextChanged: listener => { f.state.ownerListeners.add(listener); return () => f.state.ownerListeners.delete(listener) },
    onEvent: listener => { f.state.events.add(listener); return () => f.state.events.delete(listener) },
    start: request => f.api.startIpc({ sender: f.owner }, request),
    send: request => f.surface.run('agent:send', request, f.principal),
    close: request => f.surface.run('agent:close', request, f.principal),
    interrupt: request => f.surface.run('agent:interrupt', request, f.principal),
    pasteAttachment: request => f.surface.run('agent:paste-attachment', request, f.principal),
    imageQueue: request => f.queue(request),
  }
  dispose = mountAgentSessionSurface(root, {
    live: true, agentId: f.nodeId, bridge, chatComposer: true,
    getStartOptions: () => ({ surface: 'standalone-agent', tier: 'luna' }),
    onController: value => { control = value },
    onSessionChange: (snapshot, event) => {
      if (event?.kind === 'send' && f.state.waitSend) { f.state.enteredSend = true; return f.state.waitSend.promise }
      if (event?.kind === 'open') {
        if (f.state.waitBinding) return f.state.waitBinding.promise
        return f.capture.bind({ sessionId: snapshot.sessionId, computerId: f.computerId, nodeId: f.nodeId, authoritative: true })
      }
    },
  })
  await new Promise(setImmediate)
  assert.ok(control)
  const initial = await control.send('First submitted message.')
  assert.equal(initial.ok, true)
  const sourceId = initial.sessionId
  const sourceThread = f.host.sessionTranscriptMetadata(sourceId).threadId
  await beforeEnd?.({ control, root, ...f })
  const child = f.state.children[0]
  child.exitCode = 0
  child.emit('exit', 0, null)
  await new Promise(setImmediate)
  assert.equal(control.snapshot().sessionId, null)
  return { ...f, control, root, sourceId, sourceThread, bridge }
}

test('F2 actual standalone terminal event and one submitted text/image recover through the host reservation', async t => {
  const f = await mountRecovery(t)
  const submitted = 'One exact recovery message.'
  const bytes = png()
  const result = await f.control.send(submitted, { pastedImages: [{ data: bytes.toString('base64'), mime: 'image/png' }] })
  assert.equal(result.ok, true)
  assert.equal(f.state.queueCalls.filter(row => row.operation === 'ended-register').length, 1)
  assert.equal(f.state.nativeCalls, 2)
  assert.equal(f.state.starts[1].threadId, f.sourceThread, 'native recovery restores the source thread')
  assert.equal(f.state.sends, 2, 'one initial turn and exactly one recovery turn, no seed turn')
  assert.equal(f.state.turns[1].text, submitted)
  assert.equal(f.state.turns[1].images.length, 1)
  assert.deepEqual(readFileSync(f.state.turns[1].images[0].path), bytes)
  assert.deepEqual(f.capture.bindingFor(result.sessionId), { computerId: f.computerId, nodeId: f.nodeId })
  const grant = f.state.queueCalls.find(row => row.operation === 'ended-register')
  assert.equal(grant.sourceSessionId, f.sourceId)
})

test('F2 retains pre-terminal queue across ended recovery (T731 mounted review)', async t => {
  const outbox = await import('../../src/session-outbox.js')
  let queued
  const f = await mountRecovery(t, { beforeEnd: ({ control, root }) => {
    const chat = root.querySelector('.chat')
    chat.importDraft({ text: 'Already submitted before terminal.', attachments: [] })
    chat.querySelector('.chat-send').click()
    queued = outbox.list(control.snapshot().sessionId).map(row => ({ id: row.id, text: row.text }))
    assert.equal(queued.length, 1, 'busy composer queued the pre-terminal message')
  } })
  const recovery = await f.control.send('Explicit recovery message.')
  assert.equal(recovery.ok, true)
  assert.deepEqual(outbox.list(recovery.sessionId).map(row => ({ id: row.id, text: row.text })), queued)
  assert.deepEqual(outbox.list(f.sourceId), [])
})

test('F2 pre-terminal and during-registration rows retain identities and drain in submission order', async t => {
  const outbox = await import('../../src/session-outbox.js')
  let oldRow
  const f = await mountRecovery(t, { beforeEnd: ({ control, root }) => {
    const chat = root.querySelector('.chat')
    chat.importDraft({ text: 'Queued before terminal.', attachments: [] })
    chat.querySelector('.chat-send').click()
    oldRow = outbox.list(control.snapshot().sessionId)[0]
  } })
  const chat = composer(f), queue = f.bridge.imageQueue
  const registered = deferred(), release = deferred()
  f.bridge.imageQueue = async request => {
    const result = await queue(request)
    if (request.operation === 'ended-register') { registered.resolve(); await release.promise }
    return result
  }
  const recovering = f.control.send('Explicit recovery message.')
  await registered.promise
  chat.importDraft({ text: 'Queued during registration.', attachments: [] })
  chat.querySelector('.chat-send').click()
  release.resolve()
  const result = await recovering
  assert.equal(result.ok, true)
  const rows = outbox.list(result.sessionId)
  assert.equal(rows[0]?.id, oldRow.id)
  assert.deepEqual(rows.map(row => row.text), ['Queued before terminal.', 'Queued during registration.'])
  f.state.starts[1].onEvent({ type: 'turn_completed', turnId: 'inert-turn-2', status: 'completed' })
  await settled(() => f.state.sends === 3)
  f.state.starts[1].onEvent({ type: 'turn_completed', turnId: 'inert-turn-3', status: 'completed' })
  await settled(() => f.state.sends === 4)
  assert.deepEqual(f.state.turns.slice(1).map(turn => turn.text), [
    'Explicit recovery message.', 'Queued before terminal.', 'Queued during registration.',
  ])
  assert.equal(f.state.nativeCalls, 2)
})

for (const failure of ['registration', 'start', 'transfer']) {
  test(`F2 a failed ${failure} retains the pre-terminal queue for explicit recovery retry`, async t => {
    const outbox = await import('../../src/session-outbox.js')
    let queued
    const f = await mountRecovery(t, { beforeEnd: ({ control, root }) => {
      const chat = root.querySelector('.chat')
      chat.importDraft({ text: 'Keep this queued message.', attachments: [] })
      chat.querySelector('.chat-send').click()
      queued = outbox.list(control.snapshot().sessionId)[0]
    } })
    const queue = f.bridge.imageQueue, start = f.bridge.start
    let destination
    if (failure === 'registration') f.bridge.imageQueue = async request => {
      if (request.operation === 'ended-register') return { ok: false, code: 'RECOVERY_DESTINATION_REFUSED' }
      return queue(request)
    }
    if (failure === 'start') f.state.hostFailure = true
    if (failure === 'transfer') f.bridge.imageQueue = async request => {
      const result = await queue(request)
      if (request.operation === 'ended-register') {
        destination = result.result.sessionId
        for (let n = 0; n < 12; n++) assert.equal(outbox.enqueue(destination, 'Destination conflict ' + n).ok, true)
      }
      return result
    }
    const failed = await f.control.send('Recovery attempt.')
    assert.equal(failed.ok, false)
    assert.equal(failed.deliveryDisposition, 'not-sent')
    assert.equal(f.state.sends, 1, 'no provider turn on failure')
    const retainedId = failure === 'start' ? failed.sessionId : f.sourceId
    assert.deepEqual(outbox.list(retainedId), [queued], 'the retained queue survives with its exact row identity')
    assert.equal(f.state.nativeCalls, 1, 'the transfer must succeed before native admission')
    if (destination) {
      assert.equal(outbox.list(destination).length, 12, 'refusal preserves the destination too')
      for (const row of outbox.list(destination)) outbox.cancel(destination, row.id)
    }
    f.bridge.imageQueue = queue
    f.bridge.start = start
    f.state.hostFailure = false
    f.state.waitBinding = null
    const recovered = await f.control.send('Explicit recovery retry.')
    assert.equal(recovered.ok, true)
    assert.deepEqual(outbox.list(recovered.sessionId), [queued])
    assert.equal(f.state.sends, 2)
    assert.equal(f.state.turns[1].text, 'Explicit recovery retry.')
  })
}


test('T731 F2 retained queue remains visible and cancellable after a released start refusal', async t => {
  const outbox = await import('../../src/session-outbox.js')
  let queued
  const f = await mountRecovery(t, { beforeEnd: ({ control, root }) => {
    const chat = root.querySelector('.chat')
    chat.importDraft({ text: 'Retained visible queued message.', attachments: [] })
    chat.querySelector('.chat-send').click()
    queued = outbox.list(control.snapshot().sessionId)[0]
  } })
  f.state.hostFailure = true
  const failed = await f.control.send('Explicit attempt which does not start.')
  assert.equal(failed.ok, false)
  assert.equal(failed.deliveryDisposition, 'not-sent')
  assert.deepEqual(outbox.list(failed.sessionId), [queued])
  const chat = composer(f)
  const rows = [...chat.querySelectorAll('.chat-queue-row')]
  const row = rows.find(item => item.querySelector('.chat-queue-text')?.textContent === queued.text)
  assert.ok(row, 'the retained message remains visible under the failed attempt identity')
  row.querySelector('.chat-queue-cancel').click()
  assert.deepEqual(outbox.list(failed.sessionId), [], 'Unqueue targets the retained row identity')
  assert.equal(f.control.exportDraft().text, queued.text, 'Unqueue restores the exact row to the composer')
  assert.equal(f.state.nativeCalls, 1)
  assert.equal(f.state.sends, 1)
})

test('F2 recovery carries uncertain queued rows without replaying accepted or unknown work', async t => {
  const outbox = await import('../../src/session-outbox.js')
  let unknown
  const f = await mountRecovery(t, { beforeEnd: ({ control }) => {
    const id = control.snapshot().sessionId
    outbox.enqueue(id, 'Already accepted.')
    outbox.confirmDelivered(id, outbox.takeNext(id))
    outbox.enqueue(id, 'Unknown delivery.')
    const taken = outbox.takeNext(id)
    outbox.requeueFront(id, { ...taken, deliveryUnconfirmed: true })
    unknown = outbox.list(id)[0]
    outbox.enqueue(id, 'Safe queued work.')
  } })
  const result = await f.control.send('Explicit recovery.')
  assert.equal(result.ok, true)
  assert.deepEqual(outbox.list(result.sessionId)[0], unknown)
  f.state.starts[1].onEvent({ type: 'turn_completed', turnId: 'inert-turn-2', status: 'completed' })
  await settled(() => f.state.sends === 3)
  f.state.starts[1].onEvent({ type: 'turn_completed', turnId: 'inert-turn-3', status: 'completed' })
  await new Promise(setImmediate)
  assert.deepEqual(f.state.turns.map(turn => turn.text), ['First submitted message.', 'Explicit recovery.', 'Safe queued work.'])
  assert.deepEqual(outbox.list(result.sessionId), [unknown])
})

test('F2 a pre-terminal image envelope keeps its attachment identity through recovery', async t => {
  let queued
  const bytes = png()
  const f = await mountRecovery(t, { beforeEnd: async ({ control, root, queue, nodeId }) => {
    const image = await control.pasteImage(bytes.toString('base64'), 'image/png')
    assert.equal(image.ok, true)
    const chat = root.querySelector('.chat')
    chat.importDraft({ text: 'Image queued before terminal.', attachments: [{ path: image.path }] })
    chat.querySelector('.chat-send').click()
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await queue({ operation: 'read', conversationId: nodeId })
      if (read.result?.entries?.length) { queued = read.result.entries[0]; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(queued, 'the submitted image envelope must be durable before terminal')
    assert.equal(queued.state, 'not-sent')
  } })
  const result = await f.control.send('Explicit recovery.')
  assert.equal(result.ok, true)
  const read = await f.queue({ operation: 'read', conversationId: f.nodeId })
  assert.equal(read.result.destinationSessionId, result.sessionId)
  assert.deepEqual(read.result.entries, [queued], 'transfer preserves the envelope and its attachment references')
  assert.equal(f.state.sends, 2)
  f.state.starts[1].onEvent({ type: 'turn_completed', turnId: 'inert-turn-2', status: 'completed' })
  await settled(() => f.state.sends === 3)
  assert.equal(f.state.turns[2].text, queued.text)
  assert.deepEqual(readFileSync(f.state.turns[2].images[0].path), bytes)
  await f.control.imageOutbox.refresh()
  assert.equal(f.state.sends, 3, 'refresh cannot replay the accepted image envelope')
})

for (const failure of ['refused', 'reply-lost']) {
  test(`F2 image transfer ${failure} retains one bound successor and retries without replay`, async t => {
    const outbox = await import('../../src/session-outbox.js')
    let envelope, textRow
    const f = await mountRecovery(t, { beforeEnd: async ({ control, root, queue, nodeId }) => {
      const image = await control.pasteImage(png().toString('base64'), 'image/png')
      assert.equal(image.ok, true)
      const chat = root.querySelector('.chat')
      chat.importDraft({ text: 'Durable image before terminal.', attachments: [{ path: image.path }] })
      chat.querySelector('.chat-send').click()
      for (let attempt = 0; attempt < 100; attempt++) {
        const read = await queue({ operation: 'read', conversationId: nodeId })
        if (read.result?.entries?.length) { envelope = read.result.entries[0]; break }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.ok(envelope)
      const id = control.snapshot().sessionId
      outbox.enqueue(id, 'Text waiting behind recovery.')
      textRow = outbox.list(id)[0]
    } })
    const queue = f.bridge.imageQueue
    f.bridge.imageQueue = async request => {
      if (request.operation === 'transfer') {
        if (failure === 'refused') return { ok: false, code: 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED' }
        await queue(request)
        throw new Error('Transfer reply lost')
      }
      return queue(request)
    }
    const failed = await f.control.send('Not yet sent.')
    assert.equal(failed.ok, false)
    assert.equal(failed.deliveryDisposition, 'not-sent')
    const successorId = f.control.snapshot().sessionId
    assert.equal(successorId, failed.sessionId, 'the claimed successor remains available for retry')
    assert.equal(f.state.nativeCalls, 2)
    assert.equal(f.state.sends, 1)
    const held = await f.queue({ operation: 'read', conversationId: f.nodeId })
    assert.deepEqual(held.result.entries, [envelope])
    assert.equal(held.result.destinationSessionId, failure === 'refused' ? f.sourceId : successorId)
    f.state.starts[1].onEvent({ type: 'turn_completed', turnId: null, status: 'completed' })
    await f.control.imageOutbox.refresh()
    await new Promise(setImmediate)
    assert.equal(f.state.sends, 1, 'neither text nor image queue can drain before transfer is reconciled')
    assert.deepEqual(outbox.list(successorId), [textRow])
    f.bridge.imageQueue = queue
    const retried = await f.control.send('Explicit transfer retry.')
    assert.equal(retried.ok, true)
    assert.equal(retried.sessionId, successorId)
    assert.equal(f.state.nativeCalls, 2, 'retry must reuse the admitted provider')
    assert.equal(f.state.sends, 2)
    assert.equal(f.state.turns[1].text, 'Explicit transfer retry.')
    const reconciled = await f.queue({ operation: 'read', conversationId: f.nodeId })
    assert.equal(reconciled.result.destinationSessionId, successorId)
    assert.deepEqual(reconciled.result.entries, [envelope])
    assert.deepEqual(outbox.list(successorId), [textRow])
    await f.control.imageOutbox.refresh()
    assert.equal(f.state.sends, 2)
  })
}

test('F2 a second submitted message during ended registration keeps its queue position', async t => {
  const f = await mountRecovery(t), chat = composer(f), queue = f.bridge.imageQueue
  const registered = deferred(), release = deferred()
  f.bridge.imageQueue = async request => {
    const result = await queue(request)
    if (request.operation === 'ended-register') { registered.resolve(); await release.promise }
    return result
  }
  chat.importDraft({ text: 'First recovery message.', attachments: [] })
  chat.querySelector('.chat-send').click()
  await registered.promise
  chat.importDraft({ text: 'Second submitted message.', attachments: [] })
  chat.querySelector('.chat-send').click()
  assert.equal(f.state.sends, 1)
  release.resolve()
  await settled(() => f.state.sends === 2)
  f.state.starts[1].onEvent({ type: 'turn_completed', turnId: 'inert-turn-2', status: 'completed' })
  await settled(() => f.state.sends === 3)
  assert.deepEqual(f.state.turns.slice(1).map(turn => turn.text), ['First recovery message.', 'Second submitted message.'])
  assert.equal(f.state.nativeCalls, 2)
})

async function settled(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('The mounted recovery operation did not settle within 500 ms')
}
function composer(f) {
  const chat = f.root.querySelector('.chat')
  assert.ok(chat?.importDraft)
  return chat
}

test('F2 a never-submitted draft survives the terminal event without starting or sending', async t => {
  const f = await mountRecovery(t, { beforeEnd: ({ root }) => root.querySelector('.chat').importDraft({ text: 'Never submitted.', attachments: [] }) })
  await new Promise(setImmediate)
  await f.control.imageOutbox.refresh()
  assert.equal(f.state.nativeCalls, 1)
  assert.equal(f.state.sends, 1)
  assert.equal(f.control.exportDraft().text, 'Never submitted.')
})

test('F2 one composer Send waits for binding and preserves a newer unsubmitted draft', async t => {
  const f = await mountRecovery(t), chat = composer(f)
  f.state.waitBinding = deferred()
  chat.importDraft({ text: 'Submitted once.', attachments: [] })
  chat.querySelector('.chat-send').click()
  await settled(() => f.state.nativeCalls === 2)
  assert.equal(f.state.sends, 1, 'no turn before wrapper binding acknowledgement')
  chat.importDraft({ text: 'Newer unsubmitted draft.', attachments: [] })
  f.state.waitBinding.resolve({ ok: true })
  await settled(() => f.state.sends === 2)
  assert.equal(f.state.turns[1].text, 'Submitted once.')
  assert.equal(f.control.exportDraft().text, 'Newer unsubmitted draft.')
  assert.equal(f.state.nativeCalls, 2)
})

for (const disposition of ['accepted-ended', 'unknown-thrown', 'unknown-returned']) {
  test(`F2 ${disposition} submitted recovery is never restored as a draft or replayed`, async t => {
    const f = await mountRecovery(t), chat = composer(f)
    const send = f.bridge.send
    let finished = false
    f.bridge.send = async request => {
      const receipt = await send(request)
      const child = f.state.children.at(-1)
      child.exitCode = 0; child.emit('exit', 0, null)
      finished = true
      if (disposition === 'unknown-thrown') throw Object.assign(new Error('Lost delivery reply'), { code: 'AGENT_SESSION_FAILED' })
      if (disposition === 'unknown-returned') return { ok: false, code: 'AGENT_SESSION_FAILED', deliveryDisposition: 'unknown' }
      return receipt
    }
    chat.importDraft({ text: 'Do not replay this submitted message.', attachments: [] })
    chat.querySelector('.chat-send').click()
    await settled(() => finished && !f.control.snapshot().starting)
    await new Promise(setImmediate)
    assert.equal(f.control.exportDraft().text, '')
    assert.equal(f.state.sends, 2)
    assert.equal(f.state.nativeCalls, 2)
    assert.equal(f.state.turns[1].text, 'Do not replay this submitted message.')
    await f.control.imageOutbox.refresh()
    assert.equal(f.state.sends, 2)
  })
}

test('F2 owner change after ended registration refuses the successor and preserves submitted text', async t => {
  const f = await mountRecovery(t), chat = composer(f), queue = f.bridge.imageQueue
  f.bridge.imageQueue = async request => {
    const result = await queue(request)
    if (request.operation === 'ended-register') {
      f.state.account = { principal: 'changed-product-principal', signedIn: false }
      f.context()
    }
    return result
  }
  chat.importDraft({ text: 'Keep under the original owner.', attachments: [] })
  chat.querySelector('.chat-send').click()
  await settled(() => f.state.queueCalls.some(row => row.operation === 'ended-register'))
  await new Promise(setImmediate)
  assert.equal(f.state.nativeCalls, 1)
  assert.equal(f.state.sends, 1)
  assert.equal(f.control.exportDraft().text, 'Keep under the original owner.')
})

for (const outcome of ['accepted', 'unknown']) {
  test(`F2 one image composer Send uses actual durable queue and never replays ${outcome}`, async t => {
    const f = await mountRecovery(t), chat = composer(f)
    const image = await f.control.pasteImage(png().toString('base64'), 'image/png')
    assert.equal(image.ok, true)
    if (outcome === 'unknown') f.state.sendFailure = true
    chat.importDraft({ text: 'Image submitted once.', attachments: [{ path: image.path }] })
    chat.querySelector('.chat-send').click()
    await settled(() => f.state.sends === 2)
    await settled(() => chat.querySelector('.me')?.dataset.deliveryState === outcome)
    assert.equal(f.state.nativeCalls, 2)
    assert.equal(f.state.starts[1].threadId, f.sourceThread)
    assert.equal(f.state.turns[1].text, 'Image submitted once.')
    assert.equal(f.state.turns[1].images.length, 1)
    assert.equal(f.control.exportDraft().text, '')
    assert.deepEqual(f.control.exportDraft().attachments, [])
    await f.control.imageOutbox.refresh()
    await f.control.imageOutbox.refresh()
    assert.equal(f.state.sends, 2)
    assert.equal(f.state.queueCalls.filter(row => row.operation === 'ended-register').length, 1)
    assert.equal(f.state.queueCalls.filter(row => row.operation === 'dispatch').length, 1)
  })
}

test('F2 a mismatched ended reservation cannot cross the start boundary', async t => {
  const f = await mountRecovery(t), queue = f.bridge.imageQueue
  let startCalls = 0
  const start = f.bridge.start
  f.bridge.start = request => { startCalls++; return start(request) }
  f.bridge.imageQueue = async request => {
    const answer = await queue(request)
    return request.operation === 'ended-register'
      ? { ...answer, result: { ...answer.result, sourceSessionId: 'wrong-source' } } : answer
  }
  const answer = await f.control.send('Keep this submission.')
  assert.equal(answer.ok, false)
  assert.equal(answer.deliveryDisposition, 'not-sent')
  assert.equal(startCalls, 0)
  assert.equal(f.state.sends, 1)
})

test('F2 missing claimed recovery receipt cannot dispatch after native startup', async t => {
  const f = await mountRecovery(t), start = f.bridge.start
  f.bridge.start = async request => {
    const result = await start(request)
    const { recovery, ...unconfirmed } = result
    return unconfirmed
  }
  const answer = await f.control.send('Wait for actual claim acknowledgement.')
  assert.equal(answer.ok, false)
  assert.equal(answer.deliveryDisposition, 'not-sent')
  assert.equal(f.state.nativeCalls, 2)
  assert.equal(f.state.sends, 1)
})

test('F2 owner change during send publication cannot dispatch the pending recovery turn', async t => {
  const f = await mountRecovery(t)
  f.state.waitSend = deferred()
  const pending = f.control.send('Owner-bound pending send.')
  await settled(() => f.state.enteredSend)
  f.state.account = { principal: 'changed-product-principal', signedIn: false }
  f.context()
  f.state.waitSend.resolve()
  const answer = await pending
  assert.equal(answer.ok, false)
  assert.equal(answer.deliveryDisposition, 'not-sent')
  assert.equal(f.state.sends, 1)
})

for (const phase of ['start', 'send']) {
  test(`F2 returned ${phase} refusal never becomes a successful submitted recovery`, async t => {
    const f = await mountRecovery(t), original = f.bridge[phase]
    f.bridge[phase] = async request => ({ ...await original(request), ok: false,
      code: 'AGENT_SESSION_FAILED', ...(phase === 'send' ? { deliveryDisposition: 'unknown' } : {}) })
    const answer = await f.control.send('Do not turn this refusal into success.')
    assert.equal(answer.ok, false)
    assert.equal(answer.deliveryDisposition, phase === 'start' ? 'not-sent' : 'unknown')
    assert.equal(f.state.sends, phase === 'start' ? 1 : 2)
  })
}

test('F2 a changed owner before recovery cannot request the old reservation', async t => {
  const f = await mountRecovery(t)
  f.state.account = { principal: 'changed-product-principal', signedIn: false }
  f.context()
  await new Promise(setImmediate)
  const answer = await f.control.send('Do not recover for a different owner.')
  assert.equal(answer.ok, false)
  assert.equal(f.state.queueCalls.filter(row => row.operation === 'ended-register').length, 0)
  assert.equal(f.state.nativeCalls, 1)
  assert.equal(f.state.sends, 1)
})
