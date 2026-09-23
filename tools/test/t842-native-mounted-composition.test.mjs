import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createT842RetainedFixtureRoot } from './lib/t842-retained-fixture-root.mjs'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testRoot, '..', '..')
const appRoot = process.env.T842_APP_ROOT || repoRoot
const require = createRequire(import.meta.url)
const { installDomStandIn } = await import(pathToFileURL(path.join(testRoot, 'lib', 'dom-stand-in.mjs')).href)
const { createImageRetentionService } = require(path.join(appRoot, 'shell', 'image-retention-service.cjs'))
const { createImageConversation } = await import(pathToFileURL(path.join(appRoot, 'src', 'image-conversation.js')).href)
const componentsRoot = process.env.T842_COMPONENTS_ROOT || path.join(repoRoot, 'src', 'components.js')
const { buildChat } = await import(pathToFileURL(componentsRoot).href)
const dom = installDomStandIn()
test.after(() => dom.restore())

const ownerContext = { version: 1, ownerId: 't842-synthetic-owner', currentEpoch: 'epoch-1', kind: 'local' }
const conversationId = 't842-synthetic-conversation'
const currentSessionId = 'node-session-current'
const predecessorSessionId = 'node-session-predecessor'
function completeSyntheticGif() {
  // Complete known 1px GIF89a, followed by a valid comment extension carrying
  // bounded synthetic padding, then the trailer. The image remains decodable.
  const onePixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
  const body = onePixel.subarray(0, onePixel.length - 1)
  const chunks = [Buffer.from([0x21, 0xfe])]
  const paddingBytes = 300 * 1024
  for (let offset = 0; offset < paddingBytes; offset += 255) {
    const size = Math.min(255, paddingBytes - offset)
    chunks.push(Buffer.from([size]))
    chunks.push(Buffer.alloc(size, 65))
  }
  chunks.push(Buffer.from([0x00, 0x3b]))
  return Buffer.concat([body, ...chunks])
}
const syntheticImageBytes = completeSyntheticGif()
assert.equal(syntheticImageBytes.subarray(0, 6).toString('ascii'), 'GIF89a')
assert.equal(syntheticImageBytes.at(-1), 0x3b)
const hash = value => createHash('sha256').update(value).digest('hex')
const namedFixtureRoot = createT842RetainedFixtureRoot({
  baseRoot: process.env.T842_FIXTURE_ROOT,
  strictEnvironment: process.env,
  sourceRoots: [repoRoot, appRoot, path.dirname(componentsRoot)],
})
console.log('T842_RETAINED_FIXTURE ' + JSON.stringify({ root: namedFixtureRoot }))

function numericRevisions(outbox) {
  return fs.readdirSync(outbox).filter(name => /^\d+$/.test(name)).length
}
function fillActualRevisions(outbox, count) {
  const previous = JSON.parse(fs.readFileSync(path.join(outbox, '1', 'snapshot.json'), 'utf8'))
  let generation = previous.generation
  for (let index = 2; index < count; index += 1) {
    const { checksum, ...record } = previous
    Object.assign(record, { index, generation: randomUUID(), operationId: randomUUID(), previous: generation })
    generation = record.generation
    const revisionRoot = path.join(outbox, String(index))
    fs.mkdirSync(revisionRoot)
    const body = JSON.stringify(record)
    fs.writeFileSync(path.join(revisionRoot, 'snapshot.json'),
      JSON.stringify({ ...record, checksum: hash(body) }), { encoding: 'utf8', flag: 'wx' })
  }
}
function makeFixture(label) {
  const root = path.join(namedFixtureRoot, 'retained-' + label + '-' + process.pid + '-' + randomUUID())
  fs.mkdirSync(root, { recursive: true })
  const imagePath = path.join(root, 'synthetic-preview.gif')
  fs.writeFileSync(imagePath, syntheticImageBytes, { encoding: 'binary', flag: 'wx' })
  const candidateSession = {}
  const issued = new Set()
  let busy = true
  let readiness = currentSessionId + ':turn-1:active'
  const context = ownerContext
  let service
  const options = {
    root: path.join(root, 'retention'),
    authenticate(value) {
      if (value !== context) throw Object.assign(new Error('fixture owner mismatch'), { code: 'IMAGE_OWNER_CHANGED' })
      return { authenticated: true, productOwnerId: 't842-synthetic-product-owner' }
    },
    sourceAuthority() {
      return { accountId: 't842-account', provider: 'codex', issued: new Set([imagePath]) }
    },
    candidateAuthority() {
      return {
        session: candidateSession,
        sessionId: currentSessionId,
        accountId: 't842-account',
        provider: 'codex',
        issued,
        busy,
      }
    },
    authorizeTransfer({ destinationSessionId }) {
      return destinationSessionId === predecessorSessionId || destinationSessionId === currentSessionId
    },
    engineImageBytes: 8 * 1024 * 1024,
  }
  service = createImageRetentionService(options)
  const run = request => service.run({ conversationId, ...request }, context)
  const receipt = run({ operation: 'retain', operationId: randomUUID(), images: [{ path: imagePath }] }).result
  let admitted = run({
    operation: 'admit', operationId: randomUUID(), expectedGeneration: null,
    text: 'synthetic retained words', imageReceipts: [receipt],
  }).result
  admitted = run({
    operation: 'transfer', operationId: randomUUID(), expectedGeneration: admitted.generation,
    expectedDestinationSessionId: null, destinationSessionId: predecessorSessionId,
  }).result
  const outbox = path.join(options.root, hash('t842-synthetic-product-owner'), hash(conversationId), 'outbox')
  const sent = []
  const calls = []
  function setBusy(value) {
    busy = value
    readiness = currentSessionId + ':turn-1:' + (value ? 'active' : 'idle')
  }
  function setReadiness(value) { readiness = value }
  async function dispatch(request) {
    const result = await service.dispatch({ conversationId, ...request }, context, async turn => {
      sent.push(turn)
      return { deliveryDisposition: 'accepted', result: { turnId: 'synthetic-turn-' + sent.length } }
    })
    // main.cjs runImageQueue binds every native dispatch reply to the
    // initiating owner/conversation/session before the renderer may act on it.
    return {
      ...result, operation: 'dispatch', operationId: request.operationId,
      conversationId, sessionId: request.sessionId, envelopeId: request.envelopeId,
      ownerContext: context,
    }
  }
  function makeController() {
    const bridge = {
      async imageQueue(request) {
        calls.push(structuredClone(request))
        if (request.operation === 'binding') {
          return { ok: true, operation: 'binding',
            result: { sessionId: currentSessionId, conversationId, ownerContext } }
        }
        if (request.operation === 'dispatch') return dispatch(request)
        return run(request)
      },
    }
    const owner = {
      capture: () => ownerContext,
      isCurrent: value => value === ownerContext,
      start: async () => ownerContext,
      invalidate: () => {},
      snapshot: () => ({ status: 'ready', ownerContext }),
      subscribe: () => () => {},
      dispose: () => {},
    }
    return createImageConversation({
      bridge, ownerClient: owner, sessionId: currentSessionId,
      isCurrent: () => true, mayDrain: () => true,
      subscribeReady: () => () => {}, readinessRevision: () => readiness,
    })
  }
  return {
    root, outbox, run, calls, sent, setBusy, setReadiness, makeController,
    relaunch() { service = createImageRetentionService(options) },
  }
}
async function settleUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for composed renderer state')
}
function mount(controller, initialView) {
  let latest = initialView
  let publish
  const stopController = controller.subscribe(view => {
    latest = view
    publish?.(latest)
  })
  const imageOutbox = {
    subscribe(listener) {
      publish = listener
      listener(latest)
      return () => { if (publish === listener) publish = null }
    },
    async refresh() {
      latest = await controller.refresh()
      publish?.(latest)
    },
    async retry(envelopeId, view) {
      const result = await controller.retry(envelopeId, view)
      latest = await controller.refresh()
      publish?.(latest)
      return result
    },
    async cancel(envelopeId, view) {
      const result = await controller.cancel(envelopeId, view)
      latest = await controller.refresh()
      publish?.(latest)
      return result
    },
  }
  const chat = buildChat({ seed: 0, imageOutbox, onSend: () => assert.fail('queue rendering must never dispatch directly') })
  dom.document.body.appendChild(chat)
  return {
    chat,
    get view() { return latest },
    dispose() { stopController(); chat.dispose(); chat.remove() },
  }
}

test('native preview composes through relaunch, predecessor transfer, busy boundary, and exact-once send', async () => {
  const fixture = makeFixture('send')
  fillActualRevisions(fixture.outbox, 256)
  assert.equal(numericRevisions(fixture.outbox), 256, 'one envelope is retained across the actual 256 revision cap')
  assert.equal(fixture.run({ operation: 'read' }).result.entries.length, 1)
  assert.equal(fixture.run({ operation: 'read' }).result.destinationSessionId, predecessorSessionId)

  const first = fixture.makeController()
  await first.refresh()
  first.dispose()
  fixture.relaunch()
  const controller = fixture.makeController()
  const view = await controller.refresh()
  const retained = view.entries[0]
  assert.equal(retained.text, 'synthetic retained words')
  assert.equal(retained.state, 'not-sent')
  assert.equal(retained.destinationSessionId, undefined)
  assert.equal(retained.previewState, 'available')
  assert.ok(retained.thumbnail.length > 262144, 'native preview is larger than the old renderer bound')
  assert.match(retained.thumbnail, /^data:image\/gif;base64,/)

  const mounted = mount(controller, view)
  try {
    const item = mounted.chat.querySelector('.chat-image-queue-row')
    assert.ok(item)
    assert.ok(item.querySelector('.chat-image-queue-thumbnail'))
    assert.equal(item.querySelector('.chat-image-queue-thumbnail').src, retained.thumbnail)
    assert.equal(item.querySelector('.chat-image-queue-thumbnail').width, 48)
    assert.equal(item.querySelector('.chat-image-queue-thumbnail').height, 48)
    const retry = item.querySelector('.chat-image-queue-retry')
    assert.ok(retry)
    retry.click()
    await settleUntil(() => fixture.calls.filter(request => request.operation === 'dispatch').length >= 1)
    assert.equal(fixture.calls.filter(request => request.operation === 'transfer').length, 1,
      'Send again performs one guarded predecessor transfer')
    assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 1,
      'busy preflight is one no-dispatch attempt')
    assert.equal(fixture.sent.length, 0)
    await controller.signalReady()
    assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 1,
      'unchanged readiness does not re-arm the busy retry')
    fixture.setBusy(false)
    fixture.setReadiness(currentSessionId + ':turn-1:idle')
    await controller.signalReady()
    await settleUntil(() => fixture.calls.filter(request => request.operation === 'dispatch').length >= 2)
    assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 2)
    assert.equal(fixture.sent.length, 1, 'the synthetic image turn is sent once')
    assert.equal(fixture.sent[0].text, 'synthetic retained words')
    assert.equal(fixture.sent[0].images.length, 1)
    await controller.signalReady()
    assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 2,
      'accepted delivery is never replayed')
  } finally {
    mounted.dispose()
    controller.dispose()
  }
})

test('native full-cap retained row composes Remove and archives without deletion', async () => {
  const fixture = makeFixture('remove')
  fillActualRevisions(fixture.outbox, 256)
  const controller = fixture.makeController()
  const view = await controller.refresh()
  assert.equal(numericRevisions(fixture.outbox), 256)
  const mounted = mount(controller, view)
  try {
    const item = mounted.chat.querySelector('.chat-image-queue-row')
    const remove = item?.querySelector('.chat-image-queue-cancel')
    assert.ok(remove)
    assert.equal(remove.textContent, 'Remove')
    remove.click()
    await settleUntil(() => fixture.calls.some(request => request.operation === 'cancel'))
    const after = fixture.run({ operation: 'read' }).result
    assert.equal(after.entries[0].state, 'cancelled')
    const unexpectedDispatches = fixture.calls.filter(request => request.operation === 'dispatch')
    if (unexpectedDispatches.length) assert.fail('unexpected composed operations: '
      + fixture.calls.map(request => request.operation).join(','))
    assert.ok(fs.readdirSync(path.join(fixture.outbox, 'archive')).length >= 1,
      'full-cap maintenance archives old revisions instead of deleting them')
    await settleUntil(() => mounted.chat.querySelectorAll('.chat-image-queue-row').length === 0)
  } finally {
    mounted.dispose()
    controller.dispose()
  }
})
