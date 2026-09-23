import assert from 'node:assert/strict'
import test from 'node:test'
import Module, { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
const require = createRequire(import.meta.url)
const scenarioPath = require.resolve('../lib/page2-native-continuation-scenarios.cjs')
let scenarioSource = fs.readFileSync(scenarioPath, 'utf8')
// Retained negative control restores exactly the three rejected assumptions
// in memory. No production or scenario source file is changed by this control.
if (process.env.CONTINUATION_REVIEW_MUTATION === 'rejected-assumptions') {
  const changes = [
    ["  if (!await stop.isVisible()) context.unavailable('The real provider finished before text", "  await attachTwo(context)\n  if (!await stop.isVisible()) context.unavailable('The real provider finished before text"],
    ['assert.deepEqual(captured.attachments, summaries,', "assert.deepEqual(captured.attachments, summaries.map((row, i) => ({ ...row, name: ['qa-image-a.png', 'qa-image-b.png'][i] })),"],
    ["firstHostAcceptance: { observed: false,", "firstHostAcceptance: { observed: true,"],
  ]
  for (const [before, after] of changes) {
    assert.equal(scenarioSource.split(before).length, 2, 'Each rejected assumption must replace exactly one live consumer')
    scenarioSource = scenarioSource.replace(before, after)
  }
}
const candidate = new Module(scenarioPath)
candidate.filename = scenarioPath; candidate.paths = Module._nodeModulePaths(path.dirname(scenarioPath))
candidate._compile(scenarioSource, scenarioPath)
const { scenarios, acceptedTurns, assertIntent, assertCapturedContext, observationReceipt, assertDurableImageCapture } = candidate.exports
const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
test.after(() => dom.restore())
const { scenarios: shared } = require('../lib/page2-native-scenarios.cjs')
const { selectScenarios } = require('../lib/page2-native-report.cjs')
const task = { id: 'T10', words: 'Retain this current task text' }
const owner = { who: 'you', text: 'original submitted intent', turnStamp: 'turn-2', at: 100 }
const context = { who: 'you', promptKind: 'tasks', promptSource: 'toolsenabled', turnStamp: 'turn-2',
  text: 'Current relevant T tasks — Ledger revision 20. T10: Retain this current task text' }

test('host accepted intent and correctly attributed same-turn task context qualify only that observation', () => {
  assert.equal(assertIntent([owner, context], owner.text, task), owner)
})

test('an automatic history turn before person intent cannot be hidden by a later correct turn', () => {
  const seed = { who: 'action', kind: 'automatic', text: 'old history', turnStamp: 'turn-1' }
  assert.throws(() => assertIntent([seed, owner, context], owner.text, task), /automatic transcript seed/)
  assert.equal(acceptedTurns([seed, owner, context]).length, 2)
})

for (const change of [{ promptKind: 'requests' }, { promptSource: 'provider' }, { turnStamp: 'old-turn' },
  { text: 'Current relevant T tasks — Ledger revision 20. T10: Different task bytes' }]) {
  test('mismatched task evidence is refused: ' + JSON.stringify(change), () => {
    assert.throws(() => assertIntent([owner, { ...context, ...change }], owner.text, task), /current relevant T record|labeled product context/)
  })
}

test('real latency paths remain selectable after an independent first-turn context assertion fails', () => {
  const selected = selectScenarios([...shared, ...scenarios], ['continuation-startup-intent',
    'continuation-busy-send-now', 'continuation-after-stop-send-now', 'continuation-ended-send'])
  assert.equal(selected.filter(row => row.id === 'continuation-session-ready').length, 1)
  for (const id of ['continuation-busy-send-now', 'continuation-after-stop-send-now', 'continuation-ended-send']) {
    assert.deepEqual(selected.find(row => row.id === id).requires, ['continuation-session-ready'])
  }
  assert.equal(selected.some(row => row.id === 'child-start' || row.id === 'root-start'), false)
})


const completeKinds = ['tasks', 'history', 'tree', 'requests', 'role', 'tools', 'capabilities']
const captured = kinds => kinds.map(kind => ({ ...context, promptKind: kind, text: kind + ': observed context' }))

test('captured seven-kind order keeps tools and capabilities after task and history context', () => {
  assert.deepEqual(assertCapturedContext([owner, ...captured(completeKinds)], owner).map(row => row.promptKind), completeKinds)
})

test('optional kinds are not fabricated or required when absent from the observation', () => {
  assert.deepEqual(assertCapturedContext([owner, ...captured(['tasks', 'role'])], owner).map(row => row.promptKind), ['tasks', 'role'])
})

test('reordered optional context cannot count as preserved host order', () => {
  assert.throws(() => assertCapturedContext([owner, ...captured(['history', 'tasks', 'tools'])], owner), /actual host ordering/)
})

test('an eighth addition and duplicated kind cannot evade the retained bounds', () => {
  assert.throws(() => assertCapturedContext([owner, ...captured([...completeKinds, 'tasks'])], owner), /seven-kind bound/)
  assert.throws(() => assertCapturedContext([owner, ...captured(['tasks', 'tasks'])], owner), /cannot appear twice/)
})

test('task and history context cannot masquerade as assistant speech or an unknown context kind', () => {
  for (const kind of ['tasks', 'history']) {
    assert.throws(() => assertCapturedContext([owner, { ...captured([kind])[0], who: 'agent' }], owner), /labeled product context/)
  }
  assert.throws(() => assertCapturedContext([owner, ...captured(['unknown'])], owner), /known kind labels/)
})

const tick = () => new Promise(setImmediate)
test('native queuedScenario submits text to the real renderer Send now row and keeps the independent draft', async () => {
  const rows = [], sent = [], images = [], listeners = new Set()
  let busy = false, paintImages
  const emit = () => { for (const listener of listeners) listener() }
  const queue = {
    list: () => rows.slice(), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    add(text) { rows.push({ id: 'queued', text }); emit(); return { ok: true } },
    cancel(id) { const i = rows.findIndex(row => row.id === id); if (i < 0) return false; rows.splice(i, 1); emit(); return true },
  }
  const chat = buildChat({ seed: 0, chips: {}, queue,
    status: { busy: () => busy, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    onStop: async () => { busy = false; emit(); return { ok: true } },
    onSend: async text => { sent.push(text); busy = true; emit(); return { ok: true } },
    imageOutbox: { subscribe(fn) { paintImages = fn; fn({ state: 'ready', entries: [] }); return () => {} } },
    onImageIntent: async draft => {
      images.push(draft)
      paintImages({ state: 'ready', entries: [{ envelopeId: 'image-envelope', text: draft.text,
        state: 'not-sent', imageReceipts: [{ imageCount: 2 }] }] })
      return { ok: true, state: 'not-sent' }
    },
  })
  dom.document.body.appendChild(chat)
  const locator = (selector, text = null) => {
    const nodes = () => [...chat.querySelectorAll(selector)].filter(node => text === null || node.textContent.includes(text))
    return { filter: ({ hasText }) => locator(selector, hasText),
      async waitFor() { assert.equal(nodes().length, 1, 'The actual renderer must create the requested text queue row') },
      async isVisible() { return nodes().some(node => !node.hidden) } }
  }
  const card = { locator }
  // Execute the actual scenario prefix through its first queue wait. Later
  // Playwright/window/provider phases are deliberately outside this source proof.
  const source = declaredFunctionSource(scenarioSource, 'queuedScenario')
  const boundary = source.indexOf('  const draft =')
  assert.ok(boundary > 0)
  const prefix = source.slice(0, boundary) + ' return { queueRow, text }; }'
  const dependencies = { rootCard: () => card, openConversation: async () => {}, stopVisibleReply: async () => {}, marker: () => 'PREFIX_MARKER',
    attachTwo: async () => chat.importDraft({ text: '', attachments: [{ path: 'one.png' }, { path: 'two.png' }] }),
    send: async (_context, _card, text) => { chat.importDraft({ text, attachments: chat.exportDraft().attachments }); chat.querySelector('.chat-send').click(); await tick() } }
  try {
    const run = new Function(...Object.keys(dependencies), 'return (' + prefix + ')')(...Object.values(dependencies))
    const result = await run({ state: { rootId: 'node', continuationTask: { id: 'T1' } }, unavailable: reason => assert.fail(reason) })
    assert.equal(images.length, 0, 'Text Send now must not enter onImageIntent')
    assert.equal(rows[0].text, result.text)
    chat.importDraft({ text: 'independent unsent draft', attachments: [] })
    assert.equal(chat.querySelector('[data-chat-chip="halt"]').hidden, false, 'The existing halt chip survives a typed draft')
    assert.notEqual(chat.querySelector('.chat-send').getAttribute('aria-label'), 'Stop this reply')
    chat.querySelector('.chat-queue-now').click()
    for (let i = 0; i < 10 && sent.length < 2; i++) await tick()
    assert.equal(sent.length, 2)
    assert.equal(sent[1], result.text)
    assert.equal(chat.exportDraft().text, 'independent unsent draft')
  } finally { chat.dispose(); chat.remove() }
})

test('real image renderer admission exposes an image row with no text Send now control', async () => {
  let publish, admitted
  const chat = buildChat({ seed: 0, chips: {}, status: { busy: () => true }, onSend: () => assert.fail('Images must use durable admission'),
    queue: { list: () => [], subscribe: () => () => {}, add: () => assert.fail('Images cannot enter the text queue') },
    imageOutbox: { subscribe(fn) { publish = fn; fn({ state: 'ready', entries: [] }); return () => {} } },
    onImageIntent: async draft => {
      admitted = draft
      publish({ state: 'ready', entries: [{ envelopeId: 'observed-envelope', state: 'not-sent', text: draft.text, imageReceipts: [{ imageCount: 2 }] }] })
      return { ok: true, state: 'not-sent' }
    },
  })
  try {
    chat.importDraft({ text: 'exact two-image intent', attachments: [{ path: 'one.png' }, { path: 'two.png' }] })
    chat.querySelector('.chat-send').click(); await tick()
    assert.equal(admitted.text, 'exact two-image intent')
    assert.equal(admitted.images.length, 2)
    assert.equal(chat.querySelector('.chat-queue-row'), null)
    const row = chat.querySelector('.chat-image-queue-row')
    assert.equal(row.dataset.envelopeId, 'observed-envelope')
    assert.deepEqual([...row.querySelectorAll('button')].map(button => button.textContent), ['Unqueue'])
    assert.ok(chat.querySelector('.chat-image-queue-refresh'))
  } finally { chat.dispose() }
})

async function custodyToCapturedTurn(t) {
  const { createDurableImageCustody } = require('../../shell/durable-image-custody.cjs')
  const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
  const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
  const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
  // Real custody files are retained; the actual transcript store gets in-memory
  // I/O so its cleanup calls cannot delete filesystem data in this source test.
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'native-evidence-custody-'))
  const files = new Map(), missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
  const io = {
    async mkdir() {}, async readdir(directory) { return [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)) },
    async readFile(file) { return files.has(file) ? files.get(file) : missing() },
    async writeFile(file, value) { files.set(file, value) }, async open() { return { async sync() {}, async close() {} } },
    async rename(from, to) { assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from) },
    async unlink(file) { if (!files.delete(file)) missing() },
  }
  const store = createNodeTranscriptStore({ directory: root, io })
  const capture = createNodeTranscriptCapture({ store })
  const binding = { computerId: 'computer', nodeId: 'node' }, sessionId = 'session', turnId = 'captured-turn'
  capture.bind({ ...binding, sessionId })
  t.after(async () => { await capture.shutdown(); await store.shutdown() })
  let now = 100
  t.mock.method(Date, 'now', () => now)
  const pngs = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
  ].map(text => Buffer.from(text, 'base64'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const expected = pngs.map(bytes => ({ sha256: hash(bytes), size: bytes.length }))
  const custody = createDurableImageCustody({ root, authenticate: () => ({ authenticated: true, productOwnerId: 'qa-owner' }), authorizeCandidate: () => true })
  const scope = { conversationId: 'qa-conversation', accountId: 'qa-account', provider: 'codex' }
  const receipt = custody.retain({ ...scope, operationId: randomUUID(), images: pngs.map(bytes => ({ bytes, mime: 'image/png' })) }, {})
  const record = custody.reopen(receipt, {})
  const issued = custody.reissue(receipt, { ...scope, sessionId, productOwnerId: 'qa-owner' }, {})
  assert.deepEqual(issued.images.map(image => hash(fs.readFileSync(image.path))), expected.map(image => image.sha256))
  const principalOwner = {}, text = 'exact image intent', deps = {}
  for (const [key, type] of Object.entries(REQUIRED_DEPS)) deps[key] = type === 'function' ? () => null : type === 'number' ? 128 : type === 'string' ? root : {}
  let firstCapture
  Object.assign(deps, {
    agentSessions: new Map([[sessionId, { owner: principalOwner, state: 'ready', attachments: new Set(issued.images.map(image => image.path)) }]]),
    parseAgentSend: request => request, AGENT_EFFORT_VALUES: [], dialog: { showOpenDialog: async () => assert.fail('No native dialog in source proof') },
    agentIpcError: (code, message) => { throw Object.assign(new Error(message), { code }) }, rendererSafeAgentError: error => error,
    statFile: async file => { now = 300; return fs.statSync(file) },
    recordAcceptedTranscriptSend: request => capture.recordAcceptedTranscriptSend(request),
    currentAgentHost: () => ({ async sendTurn(request) {
      assert.deepEqual(request.images, issued.images.map(image => ({ path: image.path })))
      await capture.recordAcceptedTranscriptSend({ sessionId, turnId, text })
      firstCapture = (await store.read(binding)).entries[0]
      return { turnId }
    } }),
  })
  await createAgentCommandSurface(deps).run('agent:send', { sessionId, text, images: issued.images.map(image => ({ path: image.path })) },
    { kind: 'window', owner: principalOwner, mayWrite: true, label: 'QA source fixture' })
  const entries = (await store.read(binding)).entries
  assert.equal(entries.length, 1, 'Actual store must upsert one stable ID after surface enrichment')
  assert.equal(entries[0].id, firstCapture.id)
  assert.equal(firstCapture.at, 100)
  assert.equal(entries[0].at, 300)
  assert.equal(firstCapture.attachments, undefined)
  const evidence = { entry: { text, state: 'accepted', imageReceipts: [receipt] }, records: [record] }
  return { evidence, expected, captured: entries[0], entries }
}

test('actual custody reissue to surface capture binds ordered UUID names and hashes instead of original picker names', async t => {
  const f = await custodyToCapturedTurn(t)
  assertDurableImageCapture(f.evidence, f.expected, f.captured)
  assert.throws(() => assertDurableImageCapture(f.evidence, [...f.expected].reverse(), f.captured), /submitted byte hashes/)
  assert.throws(() => assertDurableImageCapture(f.evidence, f.expected, { ...f.captured, attachments: [...f.captured.attachments].reverse() }), /custody identities/)
  const wrong = structuredClone(f.evidence); wrong.records[0].id = randomUUID()
  assert.throws(() => assertDurableImageCapture(wrong, f.expected, f.captured), /observed envelope receipt/)
})

test('actual host callback then surface capture upsert cannot claim first host acceptance timing', async t => {
  const f = await custodyToCapturedTurn(t)
  const receipt = observationReceipt({ click: { epochMs: 50, monotonicMs: 10 }, overflow: false, feedback: null,
    visible: { monotonicMs: 170 }, events: [{ turnId: f.captured.turnStamp, type: 'assistant_text_delta', text: 'reply', monotonicMs: 110 }] }, f.entries, f.captured.text, 'capture-test')
  assert.equal(receipt.targetCaptureUpsertEpochMs, 300)
  assert.equal(receipt.firstHostAcceptance.observed, false, 'Mutable capture time must not claim first host acceptance')
  assert.equal(receipt.firstHostAcceptedTurn, undefined)
  assert.equal(receipt.firstTargetPublicEventMs, 100)
  assert.equal(receipt.firstExpectedVisibleMs, 160)
  assert.equal(receipt.providerWirePayload.observed, false)
  assert.equal(receipt.producerToCaptureCompleteness.observed, false)
})
