import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync, writeFileSync, mkdtempSync, realpathSync} from 'node:fs'
import path from 'node:path'
import {randomUUID, createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import {parseAst} from 'rollup/parseAst'
import {createImageConversation} from '../../src/image-conversation.js'

/*
 * This is a client-to-native join proof. The W16 review seam supplies the
 * extracted production runImageQueue body and the real retention/outbox
 * modules; this file adds the missing already-attached conversation retry.
 * Every fixture is synthetic and retained under this run's temporary root.
 */
const appRoot = path.resolve(process.env.IMAGE_APP_ROOT)
const engineRoot = path.resolve(process.env.IMAGE_ENGINE_ROOT)
const tempRoot = realpathSync(process.env.IMAGE_TEST_TEMP)
const mainPath = path.join(appRoot, 'shell/main.cjs')
const require = createRequire(mainPath)
const mainSource = readFileSync(mainPath, 'utf8')
const mainAst = parseAst(mainSource)
const runNode = mainAst.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'runImageQueue')
assert.ok(runNode, 'the actual native image queue function must exist')
const runImageQueueBody = mainSource.slice(runNode.start, runNode.end)
const helperNames = [
  'agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSend',
  'assertTrustedAgentSender', 'windowPrincipal',
]
const helperCode = helperNames.map(name => {
  const node = mainAst.body.find(candidate => candidate.type === 'FunctionDeclaration' && candidate.id.name === name)
  assert.ok(node, name)
  return mainSource.slice(node.start, node.end)
}).join('\n')
const limitCode = mainAst.body.filter(node => node.type === 'VariableDeclaration')
  .flatMap(node => node.declarations)
  .filter(node => ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH'].includes(node.id.name))
  .map(node => `const ${mainSource.slice(node.start, node.end)};`)
  .join('\n')
const helpers = new Function(
  'trustedFleetProfileSender',
  `${limitCode}\n${helperCode};return {${helperNames.join(',')}}`,
)(event => event.trusted === true)

const {createAgentCommandSurface, REQUIRED_DEPS} = require('./agent-command-surface.cjs')
const trackedSources = [
  'src/image-conversation.js',
  'src/image-queue-drain.js',
  'shell/main.cjs',
  'shell/agent-command-surface.cjs',
  'shell/image-retention-service.cjs',
  'shell/image-outbox.cjs',
  'shell/durable-image-custody.cjs',
]
const sha = value => createHash('sha256').update(value).digest('hex')
const sourceHashes = () => Object.fromEntries(trackedSources.map(file => [
  file, sha(readFileSync(path.join(appRoot, file))),
]))
const sourceBefore = sourceHashes()
const fixtureRoots = []

function image(color) {
  function crc(bytes) {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let index = 0; index < 8; index++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  function chunk(type, bytes) {
    const result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length)
    result.write(type, 4)
    bytes.copy(result, 8)
    result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, ...color]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const entryFingerprint = entry => sha(JSON.stringify({
  text: entry.text,
  imageReceipts: entry.imageReceipts,
  selection: entry.selection ?? null,
}))

async function fixture(mode = 'accepted') {
  const root = mkdtempSync(path.join(tempRoot, 't842-existing-session-retry-'))
  fixtureRoots.push(root)
  const owner = {isDestroyed: () => false}
  const ownerContext = {version: 1, ownerId: 'synthetic-owner', currentEpoch: 'synthetic-epoch', kind: 'local'}
  const bytes = image([255, 0, 0])
  const sourceImagePath = path.join(root, 'synthetic-source.png')
  writeFileSync(sourceImagePath, bytes)

  const sessions = new Map([
    ['old-destination', {
      owner, ownerKind: 'window', state: 'ready', metricsPrincipal: 'product-owner',
      attachments: new Set([sourceImagePath]), imageConversationId: null,
    }],
    ['current-session', {
      owner, ownerKind: 'window', state: 'ready', metricsPrincipal: 'product-owner',
      attachments: new Set(), imageConversationId: null,
    }],
  ])
  const metadata = new Map([
    ['old-destination', {account: 'synthetic-account', provider: 'codex'}],
    ['current-session', {account: 'synthetic-account', provider: 'codex'}],
  ])
  const bindings = new Map([
    ['old-destination', {nodeId: 'synthetic-conversation'}],
    ['current-session', {nodeId: 'synthetic-conversation'}],
  ])
  const queueCalls = []
  const deliveries = []
  const heldMessages = []
  const lifecycle = []
  const host = {
    sendTurnTracked: async request => {
      deliveries.push({
        sessionId: request.sessionId,
        text: request.text,
        images: request.images?.map(image => ({path: image.path})) || [],
      })
      if (mode === 'unknown') return {ok: false, code: 'SYNTHETIC_DELIVERY_UNKNOWN', deliveryDisposition: 'unknown'}
      return {ok: true, result: {turnId: 'synthetic-turn'}, deliveryDisposition: 'accepted'}
    },
    holdQueuedUserMessage: (sessionId, waiting) => heldMessages.push({sessionId, waiting}),
    sessionTranscriptMetadata: sessionId => metadata.get(sessionId),
    sessionDeliverySettings: () => ({model: 'synthetic-model', effort: null, provider: 'codex'}),
    createSession: () => lifecycle.push('create'),
    closeSession: () => lifecycle.push('close'),
  }
  const gate = {
    authenticate: supplied => {
      if (supplied?.ownerId !== ownerContext.ownerId || supplied?.currentEpoch !== ownerContext.currentEpoch) {
        throw Object.assign(new Error('synthetic owner changed'), {code: 'IMAGE_OWNER_CHANGED'})
      }
      return {authenticated: true, productOwnerId: 'product-owner'}
    },
    read: () => ownerContext,
  }
  const deps = {}
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    deps[name] = kind === 'function' ? () => null : kind === 'number' ? 128 : kind === 'string' ? root : {}
  }
  Object.assign(deps, {
    agentSessions: sessions,
    currentAgentHost: () => host,
    getAgentHost: () => host,
    agentIpcError: helpers.agentIpcError,
    agentPayload: helpers.agentPayload,
    boundedAgentString: helpers.boundedAgentString,
    parseAgentSend: helpers.parseAgentSend,
    rendererSafeAgentError: error => error,
    AGENT_EFFORT_VALUES: [],
    WORKSPACE_ROOT: root,
    dialog: {showOpenDialog: () => {}},
  })
  const surface = createAgentCommandSurface(deps)
  const event = {trusted: true, sender: owner}
  const principal = helpers.windowPrincipal(event)
  const environment = {
    ...helpers,
    getAgentCommandSurface: () => surface,
    getImageOwnerContext: () => gate,
    accountPrincipal: () => 'product-owner',
    agentSessions: sessions,
    agentHost: host,
    transcriptCapture: {bindingFor: sessionId => bindings.get(sessionId)},
    require,
    path,
    app: {getPath: () => root},
    resolveCapabilityRoot: () => engineRoot,
  }
  const runImageQueue = new Function(
    ...Object.keys(environment),
    `return (${runImageQueueBody})`,
  )(...Object.values(environment))
  const run = request => {
    queueCalls.push({operation: request.operation, sessionId: request.sessionId || null})
    return Promise.resolve(runImageQueue({
      ownerContext,
      conversationId: 'synthetic-conversation',
      ...request,
    }, principal))
  }

  const retained = (await run({
    operation: 'retain', sessionId: 'old-destination', operationId: randomUUID(),
    images: [{path: sourceImagePath}],
  })).result
  const admitted = (await run({
    operation: 'admit', sessionId: 'old-destination', operationId: randomUUID(), expectedGeneration: null,
    text: 'synthetic retained image', imageReceipts: [retained],
    selection: {model: 'synthetic-model', effort: null},
  })).result
  assert.equal(admitted.destinationSessionId, null)
  const moved = (await run({
    operation: 'transfer', sessionId: 'old-destination', operationId: randomUUID(),
    expectedGeneration: admitted.generation, expectedDestinationSessionId: null,
    destinationSessionId: 'old-destination',
  })).result
  const envelopeId = moved.entries[0].envelopeId
  assert.equal(moved.destinationSessionId, 'old-destination')

  const bridge = {
    ownerContext: async () => ownerContext,
    onOwnerContextChanged: () => () => {},
    imageQueue: request => run(request),
  }
  const controller = createImageConversation({
    bridge,
    sessionId: 'current-session',
    isCurrent: () => true,
    mayDrain: () => true,
    subscribeReady: () => () => {},
  })
  return {
    root, bytes, sessions, queueCalls, deliveries, heldMessages, lifecycle, controller, envelopeId,
    async read() { return (await run({operation: 'read'})).result },
  }
}

test.after(() => {
  const after = sourceHashes()
  console.log('T842_SOURCE_BEFORE ' + JSON.stringify(sourceBefore))
  console.log('T842_SOURCE_AFTER ' + JSON.stringify(after))
  for (const root of fixtureRoots) console.log('T842_FIXTURE_ROOT ' + root + ' retained=true')
  assert.deepEqual(after, sourceBefore)
})

test('current-session retry transfers an old destination and dispatches retained image exactly once', async () => {
  const fixture = await fixtureForTest('accepted')
  const unsubscribe = fixture.controller.subscribe(() => {})
  try {
    const initial = await fixture.controller.refresh()
    assert.equal(initial.destinationSessionId, 'old-destination')
    const held = await fixture.controller.signalReady()
    assert.equal(held.state, 'held')
    assert.equal(held.code, 'IMAGE_OUTBOX_DESTINATION_STALE')
    assert.equal(fixture.deliveries.length, 0, 'mount/readiness must not dispatch the stale queue')
    const before = await fixture.read()
    const beforeFingerprint = entryFingerprint(before.entries[0])
    const sessionKeys = [...fixture.sessions.keys()]
    const retried = await fixture.controller.retry(fixture.envelopeId, initial)
    assert.equal(retried.state, 'accepted')
    assert.equal(fixture.deliveries.length, 1)
    assert.equal(fixture.deliveries[0].sessionId, 'current-session')
    assert.equal(fixture.deliveries[0].text, 'synthetic retained image')
    assert.equal(fixture.deliveries[0].images.length, 1)
    assert.deepEqual(readFileSync(fixture.deliveries[0].images[0].path), fixture.bytes)
    assert.equal(fixture.queueCalls.filter(call => call.operation === 'transfer').length, 2)
    assert.equal(fixture.queueCalls.filter(call => call.operation === 'dispatch').length, 1)
    const after = await fixture.read()
    assert.equal(after.destinationSessionId, 'current-session')
    assert.equal(after.entries[0].state, 'accepted')
    assert.equal(entryFingerprint(after.entries[0]), beforeFingerprint)
    assert.deepEqual(after.entries[0].imageReceipts, before.entries[0].imageReceipts)
    assert.deepEqual([...fixture.sessions.keys()], sessionKeys)
    assert.deepEqual(fixture.lifecycle, [], 'retry must not create or close a session')
  } finally {
    unsubscribe()
    fixture.controller.dispose()
  }
})

for (const [mode, expectedCode] of [
  ['candidate-mismatch', 'IMAGE_OUTBOX_DESTINATION'],
  ['owner-drift', 'IMAGE_OWNER_CHANGED'],
]) test('current-session retry refuses ' + mode + ' without changing retained queue', async () => {
  const fixture = await fixtureForTest('accepted')
  const unsubscribe = fixture.controller.subscribe(() => {})
  try {
    const initial = await fixture.controller.refresh()
    await fixture.controller.signalReady()
    const before = await fixture.read()
    if (mode === 'candidate-mismatch') fixture.sessions.get('current-session').imageConversationId = 'other-conversation'
    else fixture.sessions.get('current-session').metricsPrincipal = 'other-owner'
    const result = await fixture.controller.retry(fixture.envelopeId, initial)
    assert.equal(result.state, 'held')
    assert.equal(result.code, expectedCode)
    assert.equal(fixture.deliveries.length, 0)
    assert.deepEqual(await fixture.read(), before)
  } finally {
    unsubscribe()
    fixture.controller.dispose()
  }
})

test('unknown delivery remains visible and explicit retry never replays it', async () => {
  const fixture = await fixtureForTest('unknown')
  const unsubscribe = fixture.controller.subscribe(() => {})
  try {
    const initial = await fixture.controller.refresh()
    await fixture.controller.signalReady()
    const first = await fixture.controller.retry(fixture.envelopeId, initial)
    assert.equal(first.state, 'unknown')
    assert.equal(fixture.deliveries.length, 1)
    const current = await fixture.controller.refresh()
    const second = await fixture.controller.retry(fixture.envelopeId, current)
    assert.equal(second.state, 'held')
    assert.equal(second.code, 'IMAGE_QUEUE_RETRY_UNAVAILABLE')
    assert.equal(fixture.deliveries.length, 1)
    const snapshot = await fixture.read()
    assert.equal(snapshot.destinationSessionId, 'current-session')
    assert.equal(snapshot.entries[0].state, 'unknown')
  } finally {
    unsubscribe()
    fixture.controller.dispose()
  }
})

async function fixtureForTest(mode) {
  return fixture(mode)
}
