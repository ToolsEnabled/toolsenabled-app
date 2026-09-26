import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')

const binding = { computerId: 'capture-test-computer', nodeId: 'capture-test-node', sessionId: 'capture-test-session' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function memoryStore({ failAccepted = false, holdAccepted = null } = {}) {
  const calls = []
  let durable = true
  let releaseHeld
  const held = holdAccepted ? new Promise(resolve => { releaseHeld = resolve }) : null
  return {
    calls,
    releaseHeld: () => releaseHeld?.(),
    append(request, options) {
      calls.push({ request: structuredClone(request), options: options === undefined ? undefined : structuredClone(options) })
      if (failAccepted && options?.accepted === true) {
        durable = true
        return Promise.reject(Object.assign(new Error('Synthetic generic transcript write failure'), { code: 'E_CAPTURE_GENERIC' }))
      }
      if (holdAccepted && options?.accepted === true) return held.then(() => ({ ok: true, durable: true }))
      return Promise.resolve({ ok: true, durable })
    },
    getStorageStatus() { return { durable, pendingWrites: 0 } },
  }
}

test('generic accepted-input failure is unsaved, exact, and explicitly retryable', async () => {
  let fail = true
  const NO_FORCED_ANSWER = Symbol('no forced answer')
  let forcedAnswer = NO_FORCED_ANSWER
  const calls = []
  const store = {
    append(request, options) {
      calls.push({ request: structuredClone(request), options: options === undefined ? undefined : structuredClone(options) })
      if (fail) return Promise.reject(Object.assign(new Error('Synthetic generic transcript write failure'), { code: 'E_CAPTURE_GENERIC' }))
      if (forcedAnswer !== NO_FORCED_ANSWER) return Promise.resolve(forcedAnswer)
      return Promise.resolve({ ok: true, durable: true })
    },
    getStorageStatus() { return { durable: true, pendingWrites: 0 } },
  }
  const capture = createNodeTranscriptCapture({ store })
  capture.bind(binding)

  let firstSettled = false
  const first = capture.recordAcceptedTranscriptSend({
    sessionId: binding.sessionId, turnId: 'accepted-turn', text: 'Exact accepted words stay in order.',
  })
  first.then(() => { firstSettled = true })
  await tick(); await tick()
  assert.equal(firstSettled, false, 'the accepted boundary stays held for retry')
  assert.equal(capture.getStorageStatus().unsaved, true)
  assert.equal(capture.getStorageStatus().error.code, 'MC_TRANSCRIPT_CAPTURE_UNSAVED')
  assert.deepEqual(calls[0], {
    request: {
      computerId: binding.computerId, nodeId: binding.nodeId,
      entries: [{
        id: `person:${binding.sessionId}:accepted-turn`, who: 'you',
        text: 'Exact accepted words stay in order.',
        at: calls[0].request.entries[0].at, turnStamp: 'accepted-turn',
      }],
    },
    options: { accepted: true },
  })

  const failedRetry = await capture.retry({ durable: true })
  assert.equal(failedRetry.ok, false)
  assert.equal(capture.getStorageStatus().unsaved, true)
  assert.equal(calls.length, 2, 'a failed retry replays once and remains retained')
  fail = false
  forcedAnswer = { ok: false, code: 'MC_TRANSCRIPT_STORAGE_FAILED' }
  const refusedRetry = await capture.retry({ durable: true })
  assert.equal(refusedRetry.ok, false)
  assert.equal(capture.getStorageStatus().unsaved, true)
  forcedAnswer = undefined
  const undefinedRetry = await capture.retry({ durable: true })
  assert.equal(undefinedRetry.ok, false)
  assert.equal(capture.getStorageStatus().unsaved, true)
  forcedAnswer = NO_FORCED_ANSWER
  const retry = await capture.retry()
  assert.equal(retry.ok, true)
  assert.equal((await first).ok, true)
  assert.equal(capture.getStorageStatus().unsaved, false)
  assert.deepEqual(calls.map(call => call.request.entries.map(entry => entry.text)), [
    ['Exact accepted words stay in order.'],
    ['Exact accepted words stay in order.'],
    ['Exact accepted words stay in order.'],
    ['Exact accepted words stay in order.'],
    ['Exact accepted words stay in order.'],
  ])
  await capture.shutdown()
})

test('shutdown seals new admission but drains an accepted callback already in flight', async () => {
  const store = memoryStore({ holdAccepted: true })
  const notices = []
  const capture = createNodeTranscriptCapture({ store, onError: error => notices.push(error) })
  capture.bind(binding)

  const accepted = capture.recordAcceptedTranscriptSend({
    sessionId: binding.sessionId, turnId: 'late-boundary-turn', text: 'Accepted before shutdown drains.',
  })
  await tick()
  const closing = capture.shutdown()
  const late = capture.recordAcceptedTranscriptSend({
    sessionId: binding.sessionId, turnId: 'late-rejected-turn', text: 'Must not be admitted after seal.',
  })
  let lateSettled = false
  late.then(() => { lateSettled = true })
  await tick()
  assert.equal(lateSettled, false, 'an already-accepted late callback stays recoverable')
  assert.equal(capture.getStorageStatus().unsaved, true)
  assert.equal(notices.length, 1)
  assert.deepEqual({ code: notices[0].code, message: notices[0].message }, {
    code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED',
    message: 'Accepted transcript input is not saved. Retry saving before closing ToolsEnabled.',
  })
  assert.equal(store.calls.length, 1)

  store.releaseHeld()
  assert.equal((await accepted).ok, true)
  await assert.rejects(closing, { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED' })
  assert.equal((await capture.retry({ durable: true })).ok, true)
  assert.equal((await late).ok, true)
  await capture.shutdown()
  assert.deepEqual(store.calls.map(call => call.request.entries.map(entry => entry.text)), [
    ['Accepted before shutdown drains.'],
    ['Must not be admitted after seal.'],
  ])
})

test('an accepted input without an authoritative binding stays unsaved until bind and retry', async () => {
  const calls = []
  const notices = []
  const store = {
    append(request, options) {
      calls.push({ request: structuredClone(request), options: structuredClone(options) })
      return Promise.resolve({ ok: true, durable: true })
    },
    getStorageStatus() { return { durable: true, pendingWrites: 0 } },
  }
  const capture = createNodeTranscriptCapture({ store, onError: error => notices.push(error) })
  let settled = false
  const pending = capture.recordAcceptedTranscriptSend({
    sessionId: binding.sessionId, turnId: 'unbound-turn', text: 'Keep this exact unbound input.',
  })
  pending.then(() => { settled = true })
  await tick(); await tick()
  assert.equal(settled, false)
  assert.equal(calls.length, 0, 'no ownership is invented before bind')
  assert.equal(capture.getStorageStatus().unsaved, true)
  assert.equal(notices.length, 1)
  assert.deepEqual({ code: notices[0].code, message: notices[0].message }, {
    code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED',
    message: 'Accepted transcript input is not saved. Retry saving before closing ToolsEnabled.',
  })
  assert.equal((await capture.retry({ durable: true })).ok, false)
  capture.bind(binding)
  assert.equal((await capture.retry({ durable: true })).ok, true)
  assert.equal((await pending).ok, true)
  assert.equal(calls[0].request.computerId, binding.computerId)
  assert.equal(calls[0].request.nodeId, binding.nodeId)
  assert.equal(calls[0].request.entries[0].text, 'Keep this exact unbound input.')
  assert.deepEqual(calls[0].options, { accepted: true })
  await capture.shutdown()
})

test('a packet admitted before seal drains even when it was queued behind another packet', async () => {
  let releaseFirst
  let firstWrite = true
  const writes = []
  const store = {
    appendText(request, options) {
      writes.push({ request: structuredClone(request), options: structuredClone(options) })
      if (firstWrite) {
        firstWrite = false
        return new Promise(resolve => { releaseFirst = () => resolve({ ok: true, durable: true }) })
      }
      return Promise.resolve({ ok: true, durable: true })
    },
    getStorageStatus() { return { durable: true, pendingWrites: 0 } },
  }
  const capture = createNodeTranscriptCapture({ store })
  capture.bind(binding)

  const first = capture.packet({ sessionId: binding.sessionId,
    event: { type: 'assistant_text_delta', turnId: 'queued-turn', text: 'First packet. ' } })
  await tick()
  const second = capture.packet({ sessionId: binding.sessionId,
    event: { type: 'assistant_text_delta', turnId: 'queued-turn', text: 'Second packet.' } })
  const drain = capture.sealForShutdown()
  releaseFirst()
  await Promise.all([first, second, drain])
  assert.deepEqual(writes.map(write => write.request.text), ['First packet. ', 'Second packet.'])
  assert.ok(writes.every(write => write.options.accepted === true))
  await capture.shutdown()
})

test('an unexpected accepted-input preparation failure stays unsaved and replays exactly', async () => {
  let failPreparation = true
  const calls = []
  const notices = []
  const attachments = []
  attachments.slice = () => {
    if (failPreparation) throw new Error('Synthetic attachment preparation failure')
    return []
  }
  const store = {
    append(request, options) {
      calls.push({ request: structuredClone(request), options: structuredClone(options) })
      return Promise.resolve({ ok: true, durable: true })
    },
    getStorageStatus() { return { durable: true, pendingWrites: 0 } },
  }
  const capture = createNodeTranscriptCapture({
    store,
    onError: error => {
      notices.push(error)
      throw new Error('Synthetic notice listener failure')
    },
  })
  capture.bind(binding)

  let settled = false
  const accepted = capture.recordAcceptedTranscriptSend({
    sessionId: binding.sessionId, turnId: 'preparation-failure-turn',
    text: 'Exact accepted words survive preparation failure.', attachments,
  })
  accepted.then(() => { settled = true })
  await tick(); await tick()
  assert.equal(settled, false, 'unexpected preparation failure remains pending')
  assert.equal(calls.length, 0, 'no write starts before preparation succeeds')
  assert.equal(capture.getStorageStatus().unsaved, true)
  assert.equal(notices.length, 1)
  assert.deepEqual({ code: notices[0].code, message: notices[0].message }, {
    code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED',
    message: 'Accepted transcript input is not saved. Retry saving before closing ToolsEnabled.',
  })
  await assert.rejects(capture.shutdown, { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED' })

  failPreparation = false
  assert.equal((await capture.retry({ durable: true })).ok, true)
  assert.equal((await accepted).ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.entries[0].text, 'Exact accepted words survive preparation failure.')
  assert.deepEqual(calls[0].options, { accepted: true })
  await capture.shutdown()
})

test('metadata refusal replays with current fingerprint without replacing a newer binding', async () => {
  const calls = []
  const metadataBySession = new Map([
    ['old-session', { threadId: 'old-thread-v1', provider: 'codex', account: null }],
    ['new-session', { threadId: 'new-thread-v1', provider: 'codex', account: null }],
  ])
  let oldRefused = true
  let currentNativeSessionId = null
  const oldBinding = { computerId: 'metadata-test-computer', nodeId: 'metadata-test-node', sessionId: 'old-session' }
  const newBinding = { computerId: oldBinding.computerId, nodeId: oldBinding.nodeId, sessionId: 'new-session' }
  const store = {
    calls,
    bindSessionMetadata(request) {
      calls.push(structuredClone(request))
      if (request.sessionId === oldBinding.sessionId && oldRefused) {
        return Promise.reject(Object.assign(new Error('Synthetic metadata refusal'), { code: 'E_METADATA_REFUSED' }))
      }
      if (request.replace !== true && currentNativeSessionId && currentNativeSessionId !== request.sessionId) {
        return Promise.resolve({ ok: true, unchanged: true, durable: true })
      }
      currentNativeSessionId = request.sessionId
      return Promise.resolve({ ok: true, durable: true })
    },
    async retry() {
      oldRefused = false
      return { ok: true, durable: true }
    },
    getStorageStatus() { return { durable: !oldRefused, pendingWrites: 0 } },
    waitForStorage() { return Promise.resolve({ ok: true, durable: !oldRefused }) },
  }
  const capture = createNodeTranscriptCapture({
    store,
    sessionMetadata: sessionId => metadataBySession.get(sessionId) || null,
  })

  capture.bind({ ...oldBinding, authoritative: true })
  const oldPacket = capture.packet({
    sessionId: oldBinding.sessionId,
    event: { type: 'turn_completed', turnId: 'old-turn', status: 'completed' },
  })
  let oldPacketSettled = false
  oldPacket.then(() => { oldPacketSettled = true })
  await tick(); await tick()
  assert.equal(oldPacketSettled, false, 'the packet remains held behind refused metadata durability')
  assert.equal(capture.getStorageStatus().unsaved, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, oldBinding.sessionId)
  assert.equal(calls[0].replace, true)

  capture.bind({ ...newBinding, authoritative: true })
  await tick(); await tick()
  assert.equal(currentNativeSessionId, newBinding.sessionId, 'the newer authoritative binding wins')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].sessionId, newBinding.sessionId)
  assert.equal(calls[1].replace, true)

  metadataBySession.set(oldBinding.sessionId, { threadId: 'old-thread-v2', provider: 'codex', account: null })
  await store.retry()
  const replay = await capture.retry({ durable: true })
  assert.equal(replay.ok, true)
  await tick()
  assert.equal(oldPacketSettled, true, 'metadata replay releases the held packet')
  assert.equal(calls.length, 3)
  assert.equal(calls[2].sessionId, oldBinding.sessionId)
  assert.equal(calls[2].metadata.threadId, 'old-thread-v2', 'retry reads the current authoritative fingerprint')
  assert.equal(calls[2].replace, false, 'stale old state cannot replace the newer binding')
  assert.equal(currentNativeSessionId, newBinding.sessionId, 'replay does not overwrite newer ownership')
  await oldPacket
  await capture.shutdown()
})
