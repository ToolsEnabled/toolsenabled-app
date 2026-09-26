import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createAgentHost } from '../../shell/agent-host.cjs'
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const binding = { computerId: 'synthetic-computer', nodeId: 'synthetic-node', sessionId: 'synthetic-session' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const missing = () => Object.assign(new Error('No fixture file'), { code: 'ENOENT' })

async function fixture(t, code = 'ENOSPC') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-backpressure-'))
  t.diagnostic('RETAINED_BACKPRESSURE_FIXTURE ' + directory)
  let failing = false, attempted = 0
  const notifications = []
  const io = { ...fs,
    unlink: async () => { throw missing() },
    rm: async () => { throw new Error('Fixture deletion is forbidden') },
    writeFile: async (...args) => {
      if (failing) { attempted++; throw Object.assign(new Error('Synthetic persistent write failure'), { code }) }
      return fs.writeFile(...args)
    },
    open: async (...args) => {
      const handle = await fs.open(...args)
      if (args[1] !== 'a') return handle
      return {
        close: () => handle.close(), sync: () => handle.sync(),
        writeFile: async text => {
          if (failing) { attempted++; throw Object.assign(new Error('Synthetic persistent write failure'), { code }) }
          return handle.writeFile(text)
        },
      }
    },
  }
  const store = createNodeTranscriptStore({ directory, io, onStorageError: error => notifications.push(error.code) })
  const capture = createNodeTranscriptCapture({ store })
  capture.bind(binding)
  return { directory, store, capture, notifications,
    fail(value) { failing = value }, attempts: () => attempted,
    packet: text => capture.packet({ sessionId: binding.sessionId, event: { type: 'assistant_text_delta', turnId: 'turn', text } }),
  }
}

for (const code of ['ENOSPC', 'EIO']) test(code + ' holds the producer boundary until explicit save retry succeeds', async t => {
  const f = await fixture(t, code)
  await f.packet('saved prefix; ')
  await f.capture.flushNode(binding)
  f.fail(true)
  let boundaryFinished = false
  const boundary = Promise.resolve(f.packet('held suffix')).then(() => { boundaryFinished = true })
  await f.capture.flushNode(binding).catch(() => {})
  await tick()
  assert.equal(boundaryFinished, false, 'returning from capture would admit another provider event')
  const page = await f.store.read(binding)
  assert.equal(page.entries[0].text, 'saved prefix; held suffix')
  assert.equal(page.durable, false)
  assert.equal(f.notifications.length, 1)
  const attempts = f.attempts()
  await tick(); await tick()
  assert.equal(f.attempts(), attempts, 'a pending boundary cannot retry writes on a timer')
  f.fail(false)
  assert.equal((await f.store.retry()).durable, true)
  await boundary
  assert.equal(boundaryFinished, true)
  await f.packet('; resumed')
  assert.equal((await f.store.read(binding)).entries[0].text, 'saved prefix; held suffix; resumed')
})

async function hostFixture(t, admission = () => {}, send = async () => ({ turnId: 'synthetic-turn' })) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-host-transcript-boundary-'))
  t.diagnostic('RETAINED_HOST_TRANSCRIPT_FIXTURE ' + directory)
  let callback, sends = 0
  t.mock.method(engine, 'startCodexSession', async options => {
    callback = options.onEvent
    return { threadId: 'synthetic-thread', close() {}, adapter: {
      async sendTurn() { sends++; return send() },
      async interrupt() {}, answerApproval() {},
    } }
  })
  const host = createAgentHost({
    enginePath, defaultCwd: directory, profileRoot: path.parse(directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    assertTranscriptWritable: admission,
  })
  t.after(() => host.closeAll())
  await host.startSession({ sessionId: binding.sessionId })
  return { host, emit: event => callback(event), sends: () => sends }
}

test('real host refuses new sends before dispatch and leaves the supplied words and picture untouched', async t => {
  let full = true
  const refusal = Object.assign(new Error('The disk is full. Free disk space, then retry saving.'), { code: 'MC_TRANSCRIPT_DISK_FULL' })
  const f = await hostFixture(t, () => { if (full) throw refusal })
  const request = { sessionId: binding.sessionId, text: 'Unsent synthetic words.',
    images: [{ path: path.join(os.tmpdir(), 'synthetic-picture.png') }], origin: 'person' }
  const retained = structuredClone(request)
  await assert.rejects(f.host.sendTurn(request), { code: 'MC_TRANSCRIPT_DISK_FULL' })
  assert.equal(f.sends(), 0)
  assert.deepEqual(request, retained)
  full = false
  await f.host.sendTurn({ sessionId: binding.sessionId, text: request.text, origin: 'person' })
  assert.equal(f.sends(), 1)
})

test('real host returns an asynchronous capture boundary to the native event source', async t => {
  const f = await hostFixture(t)
  const held = Promise.withResolvers()
  let forwarded = 0, finished = false
  f.host.onEvent(packet => { if (packet.event.type === 'assistant_text_delta') { forwarded++; return held.promise } })
  const delivery = Promise.resolve(f.emit({ type: 'assistant_text_delta', turnId: 'held-turn', text: 'Held event.' }))
    .then(() => { finished = true })
  await tick()
  assert.equal(forwarded, 1)
  assert.equal(finished, false, 'native producer must see the listener promise')
  held.resolve()
  await delivery
  assert.equal(finished, true)
})

test('a full-disk hold retains the new chunk without copying an unbounded saved reply into memory', async t => {
  const f = await fixture(t)
  const prefix = 'Previously durable words. '.repeat(12000)
  await f.packet(prefix)
  f.fail(true)
  const boundary = Promise.resolve(f.packet('small new suffix'))
  await f.capture.flushNode(binding)
  const state = f.store.getStorageStatus()
  assert.ok(Number.isInteger(state.retainedBytes) && state.retainedBytes > 0, 'the held byte count is measured')
  assert.ok(state.retainedBytes < 8192, 'retention must reference durable history instead of copying it')
  assert.equal((await f.store.read(binding)).entries[0].text, prefix + 'small new suffix')
  f.fail(false)
  await f.store.retry()
  await boundary
  assert.equal((await f.store.read(binding)).entries[0].text, prefix + 'small new suffix')
})

test('capture admits no later provider event while a refused event is held, then drains every word in order', async t => {
  const f = await fixture(t)
  await f.packet('Durable prefix. ')
  f.fail(true)
  const first = Promise.resolve(f.packet('Held event. '))
  await f.capture.flushNode(binding)
  const queued = Array.from({ length: 20 }, (_, index) => Promise.resolve(f.packet('Later ' + index + '. ')))
  await tick(); await tick()
  const held = await f.store.read(binding)
  assert.equal(held.entries[0].text, 'Durable prefix. Held event. ',
    'only the admitted event belongs to the store; later events stay behind producer backpressure')
  const bytes = held.retainedBytes
  await tick()
  assert.equal(f.store.getStorageStatus().retainedBytes, bytes)
  f.fail(false)
  await f.store.retry()
  await first
  await Promise.all(queued)
  assert.equal((await f.store.read(binding)).entries[0].text,
    'Durable prefix. Held event. ' + Array.from({ length: 20 }, (_, index) => 'Later ' + index + '. ').join(''))
})

test('accepted input shares the capture storage pause while preserving every already-accepted turn', async t => {
  const f = await fixture(t)
  f.fail(true)
  let firstFinished = false
  const first = f.capture.recordAcceptedTranscriptSend({ sessionId: binding.sessionId, turnId: 'accepted-first', text: 'Accepted before refusal.' })
    .then(() => { firstFinished = true })
  await f.capture.flushNode(binding).catch(() => {})
  assert.equal(firstFinished, false, 'the accepted prompt holds its producer until the save is durable')
  const queued = Array.from({ length: 12 }, (_, index) =>
    f.capture.recordAcceptedTranscriptSend({ sessionId: binding.sessionId, turnId: 'accepted-' + index, text: 'Already accepted ' + index }))
  await tick(); await tick()
  const before = await f.store.read(binding)
  assert.equal(before.entries.length, 1, 'later accepted inputs wait upstream rather than extending the retained store')
  const bytes = before.retainedBytes
  await tick()
  assert.equal(f.store.getStorageStatus().retainedBytes, bytes)
  f.fail(false)
  await f.store.retry()
  await f.capture.retry({ durable: true })
  await first
  await Promise.all(queued)
  const after = await f.store.read(binding)
  assert.deepEqual(after.entries.map(entry => entry.text),
    ['Accepted before refusal.', ...Array.from({ length: 12 }, (_, index) => 'Already accepted ' + index)])
})

test('host close keeps accepted-prompt capture until a late provider acknowledgement is durably recorded', async t => {
  const ack = Promise.withResolvers(), saved = Promise.withResolvers(), dispatched = Promise.withResolvers()
  let closing, sending, closed = false
  t.after(async () => { ack.resolve({ turnId: 'late-accepted' }); saved.resolve(); await Promise.allSettled([closing, sending]) })
  const f = await hostFixture(t, () => {}, () => { dispatched.resolve(); return ack.promise })
  const accepted = []
  f.host.onAcceptedPrompt(request => { accepted.push(request); return saved.promise })
  sending = f.host.sendTurn({ sessionId: binding.sessionId, text: 'Words accepted while closing.', origin: 'person' }).catch(error => error)
  await dispatched.promise
  closing = f.host.closeAll().then(() => { closed = true })
  await tick()
  ack.resolve({ turnId: 'late-accepted' })
  await tick()
  assert.equal(accepted[0]?.text, 'Words accepted while closing.')
  assert.equal(closed, false, 'closing must preserve capture until the accepted words save')
  saved.resolve()
  await closing
  await sending
  assert.equal(closed, true)
})
test('host pending-admission state outlives session closure but clears on a definite unaccepted refusal', async t => {
  const ack = Promise.withResolvers(), dispatched = Promise.withResolvers()
  let closing, sending
  t.after(async () => { ack.reject(Object.assign(new Error('Synthetic provider refused.'), { code: 'AGENT_ENGINE_REFUSED' })); await Promise.allSettled([closing, sending]) })
  const f = await hostFixture(t, () => {}, () => { dispatched.resolve(); return ack.promise })
  const accepted = []
  f.host.onAcceptedPrompt(request => accepted.push(request))
  sending = f.host.sendTurn({ sessionId: binding.sessionId, text: 'Unaccepted synthetic words.', origin: 'person' }).catch(error => error)
  await dispatched.promise
  closing = f.host.closeAll()
  await tick()
  assert.equal(f.host.hasPendingTranscriptAdmissions?.(), true)
  ack.reject(Object.assign(new Error('Synthetic provider refused.'), { code: 'AGENT_ENGINE_REFUSED' }))
  await closing
  await sending
  assert.equal(f.host.hasPendingTranscriptAdmissions(), false)
  assert.deepEqual(accepted, [])
})
