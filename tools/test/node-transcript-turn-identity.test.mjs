import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { installDomStandIn } = await import(process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href : './lib/dom-stand-in.mjs')
const { restore } = installDomStandIn(globalThis)
after(restore)
const { buildChat } = await import('../../src/components.js')
const sessionId = 'd63849e4-c442-4dc6-9eb4-d6bb0c6937bc'
const turnId = '7884fa80-446d-478a-bdb2-ac31a9bb4a2d'
const node = { computerId: 'computer', nodeId: 'local-observer' }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-turn-identity-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { directory, store: createNodeTranscriptStore({ directory }) }
}

test('native capture, disk reopen, client hydration and chat retain a fast reply after its own request', async t => {
  const { directory, store } = await fixture(t)
  const capture = createNodeTranscriptCapture({ store })
  capture.bind({ sessionId, ...node })
  capture.packet({ sessionId, event: { type: 'assistant_text_delta', turnId, text: 'actual tool result' } })
  capture.packet({ sessionId, event: { type: 'turn_completed', turnId, status: 'success' } })
  await capture.flushNode(node)
  // The real local provider can finish before the accepted-send acknowledgement.
  await capture.recordAcceptedTranscriptSend({ sessionId, turnId, text: 'read the file' })
  await capture.shutdown()
  const raw = await store.read({ ...node, includeRecoveryFiles: true })
  assert.deepEqual(raw.entries.map(e => e.who), ['agent', 'you'], 'retain capture order on disk')
  const persisted = JSON.parse(await fs.readFile(raw.entries[0].recoveryFiles[0], 'utf8'))
  assert.equal(persisted.turnStamp, turnId, 'the native capture must persist the identity, not just the renderer')
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  const client = createNodeTranscriptClient({ computerId: node.computerId, bridge: reopened })
  await client.ready
  const history = client.get(node.nodeId).lines
  assert.deepEqual(history.map(e => e.turnStamp), [turnId, turnId])
  const chat = buildChat({ title: 'Local', history, seed: 0, chips: {}, onSend() {},
    status: { busy: () => false, subscribe: () => () => {} } })
  const rows = [...chat.querySelector('.chat-log').children].filter(e => e.classList.contains('msg'))
  assert.deepEqual(rows.map(e => e.querySelector('.chat-msg-text')?.textContent), ['read the file', 'actual tool result'])
  assert.deepEqual(rows.map(e => e.querySelector('.turn-stamp')?.textContent), [turnId, turnId])
  assert.deepEqual((await reopened.read(node)).entries.map(e => e.who), ['agent', 'you'], 'painting must not rewrite history')
  client.dispose()
  await reopened.shutdown()
})

test('older native capture IDs restore missing stamps without changing stored bytes or overriding explicit stamps', async t => {
  const { store } = await fixture(t)
  const cases = [
    { id: `agent:${sessionId}:${turnId}`, who: 'agent', text: 'old local answer' },
    { id: `agent:${sessionId}:acp-turn-1`, who: 'agent', text: 'old ACP answer' },
    { id: `agent:${sessionId}:different`, who: 'agent', text: 'explicit', turnStamp: 'authoritative' },
    { id: 'agent:arbitrary:not-a-native-session', who: 'agent', text: 'unknown' },
    { id: `you:${sessionId}:${turnId}`, who: 'you', text: 'unknown owner identity' },
    { id: `agent:${sessionId}:`, who: 'agent', text: 'empty' },
  ]
  await store.append({ ...node, entries: cases })
  const page = await store.read({ ...node, includeRecoveryFiles: true })
  assert.deepEqual(page.entries.map(e => e.turnStamp), [turnId, 'acp-turn-1', 'authoritative', undefined, undefined, undefined])
  for (const [index, entry] of page.entries.entries()) {
    assert.deepEqual(JSON.parse(await fs.readFile(entry.recoveryFiles[0], 'utf8')), cases[index])
  }
  await store.shutdown()
})

test('stream flushes retain one immutable bounded turn identity across store reopen', async t => {
  const { directory, store } = await fixture(t)
  const request = { ...node, entryId: 'stream', text: 'first', turnStamp: turnId }
  await store.appendText(request)
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  await reopened.appendText({ ...request, text: ' second' })
  await reopened.appendText({ ...request, text: ' third', turnStamp: undefined })
  await assert.rejects(reopened.appendText({ ...request, text: ' WRONG', turnStamp: 'another-turn' }), /turn identity/)
  for (const stamp of ['', 'x'.repeat(513), 'bad\0stamp', 42]) {
    await assert.rejects(reopened.appendText({ ...request, turnStamp: stamp }), /identity/)
  }
  const page = await reopened.read(node)
  assert.equal(page.entries[0].text, 'first second third')
  assert.equal(page.entries[0].turnStamp, turnId)
  await reopened.shutdown()
})


for (const streaming of [true, false]) {
  test(`native capture preserves separate messages across flush and reopen: streaming=${streaming}`, async t => {
    const { directory, store } = await fixture(t)
    const capture = createNodeTranscriptCapture({ store })
    capture.bind({ sessionId, ...node })
    const packet = event => capture.packet({ sessionId, event: { turnId, ...event } })
    if (streaming) packet({ type: 'assistant_text_delta', text: 'Before the tool.' })
    packet({ type: 'assistant_text', text: 'Before the tool.' })
    await capture.flushNode(node)
    packet({ type: 'tool_call', toolCallId: 'call-one', tool: 'host.exec' })
    packet({ type: 'tool_result', toolCallId: 'call-one' })
    if (streaming) {
      packet({ type: 'assistant_text_delta', text: 'After ' })
      await capture.flushNode(node)
      packet({ type: 'assistant_text_delta', text: 'the tool.' })
    }
    packet({ type: 'assistant_text', text: 'After the tool.' })
    packet({ type: 'turn_completed', status: 'completed' })
    await capture.shutdown(); await store.shutdown()
    const reopened = createNodeTranscriptStore({ directory })
    const rows = (await reopened.read(node)).entries
    assert.equal(rows.length, 1)
    assert.equal(rows[0].text, 'Before the tool.\n\nAfter the tool.')
    assert.equal(rows[0].turnStamp, turnId)
    await reopened.shutdown()
  })
}

test('native speech capture follows the renderer exclusion for courier messages', async t => {
  const { store } = await fixture(t)
  const capture = createNodeTranscriptCapture({ store })
  capture.bind({ sessionId, ...node })
  capture.packet({ sessionId, event: { type: 'assistant_text_delta', turnId, text: 'Courier words', treeDelivery: true } })
  capture.packet({ sessionId, event: { type: 'assistant_text_delta', turnId, text: 'Actual answer' } })
  capture.packet({ sessionId, event: { type: 'turn_completed', turnId, status: 'success' } })
  await capture.shutdown()
  assert.equal((await store.read(node)).entries[0].text, 'Actual answer')
  await store.shutdown()
})


test('a tool boundary separates a delta-only message from a later whole message', async t => {
  const { store } = await fixture(t)
  const capture = createNodeTranscriptCapture({ store })
  capture.bind({ sessionId, ...node })
  for (const event of [
    { type: 'assistant_text_delta', text: 'First message.' },
    { type: 'tool_call', toolCallId: 'boundary' },
    { type: 'tool_result', toolCallId: 'boundary' },
    { type: 'assistant_text', text: 'Second message.' },
    { type: 'turn_completed', status: 'success' },
  ]) capture.packet({ sessionId, event: { turnId, ...event } })
  await capture.shutdown()
  assert.equal((await store.read(node)).entries[0].text, 'First message.\n\nSecond message.')
  await store.shutdown()
})

/* T366 -- THE OPENING OF AN OLD REPLY IS STILL READ TWICE.
 *
 * A spill written before the capture fix holds the deltas captured so far
 * followed by the provider's whole aggregate, and the aggregate begins with
 * those deltas. Only the case where the two halves are equal was repaired, so
 * every reply whose aggregate landed mid-run still opens by repeating itself
 * every time the conversation is reopened. MEASURED on the owner's LIVE
 * transcripts, 2026-09-19: 576 of 4124 legacy spills repaired, 2808 not.
 *
 * These call the real store with values and read back what the chat is handed.
 * They do not name the repair or how it is spelled.
 */
async function legacySpill(t, spillText) {
  const { directory, store } = await fixture(t)
  await store.appendText({ ...node, entryId: 'legacy-turn', text: 'seed', turnStamp: turnId })
  const [recordPath] = (await store.read({ ...node, includeRecoveryFiles: true })).entries[0].recoveryFiles
  // A record from before the fix carries no `textWhole` marker.
  const { textWhole: _written, ...legacy } = JSON.parse(await fs.readFile(recordPath, 'utf8'))
  await fs.writeFile(recordPath, JSON.stringify(legacy))
  await fs.writeFile(`${recordPath}.text`, spillText)
  const page = await store.read(node)
  await store.shutdown()
  return page.entries[0].text
}

test('an old reply whose opening was captured twice is handed over once', async t => {
  const deltas = 'I will start by reading the brief.'
  const reply = `${deltas}\n\nHere is what it says, at length, with the rest of the answer following.`
  assert.equal(await legacySpill(t, deltas + reply), reply,
    'the person reads the opening sentence once, and keeps the whole reply')
})

test('an old reply captured twice in full is still handed over once', async t => {
  const reply = 'The short answer.'
  assert.equal(await legacySpill(t, reply + reply), reply, 'the case that already worked keeps working')
})

test('an old reply that never doubled is handed over unchanged', async t => {
  for (const intact of [
    'A single answer with no repeated opening at all.',
    'Yes.',
    '',
    'ab',
  ]) {
    assert.equal(await legacySpill(t, intact), intact, `nothing is removed from ${JSON.stringify(intact)}`)
  }
})

test('reading a record does not rewrite it, so every read gives the same answer', async t => {
  /* The repair cannot tell a captured repeat from a reply that really opens by
     repeating itself, so it must not be able to compound: the bytes stay on
     disk untouched and each read starts from them again. That is what stops a
     conversation losing a little more of its opening every time it is opened. */
  const spill = 'Ready. Ready. Ready. Ready. And then the rest of the answer.'
  const { directory, store } = await fixture(t)
  await store.appendText({ ...node, entryId: 'legacy-turn', text: 'seed', turnStamp: turnId })
  const [recordPath] = (await store.read({ ...node, includeRecoveryFiles: true })).entries[0].recoveryFiles
  const { textWhole: _written, ...legacy } = JSON.parse(await fs.readFile(recordPath, 'utf8'))
  await fs.writeFile(recordPath, JSON.stringify(legacy))
  await fs.writeFile(`${recordPath}.text`, spill)

  const first = (await store.read(node)).entries[0].text
  const second = (await store.read(node)).entries[0].text
  assert.equal(second, first, 'two reads of one record agree')
  assert.equal(await fs.readFile(`${recordPath}.text`, 'utf8'), spill, 'the original bytes are still on disk')
  assert.ok(first.endsWith('And then the rest of the answer.'), 'the tail of the reply is never touched')
  await store.shutdown()
})

test('a spill the fixed path owns is never examined', async t => {
  const { directory, store } = await fixture(t)
  // appendText marks its own record, so a reply that genuinely repeats itself
  // from its first byte survives intact.
  await store.appendText({ ...node, entryId: 'owned', text: 'Go. Go. ', turnStamp: turnId })
  await store.appendText({ ...node, entryId: 'owned', text: 'And the rest.' })
  const page = await store.read(node)
  assert.equal(page.entries[0].text, 'Go. Go. And the rest.')
  await store.shutdown()
})
