import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const binding = { computerId: 'fixture-computer', nodeId: 'fixture-node', sessionId: 'fixture-session' }
const noEntry = () => Object.assign(new Error('Absent retained fixture entry'), { code: 'ENOENT' })

// Only this new, retained directory is touched. Deletion operations are inert;
// atomic replacements remain real. Linux failure writes use the kernel's full
// device: no filesystem is filled and no permission or mount is changed.
async function fixture(t, { kernelFull = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-transcript-disk-full-'))
  t.diagnostic('RETAINED_TRANSCRIPT_FIXTURE ' + directory)
  let full = false
  let attempts = 0
  let partial = false
  const errors = []
  let onRename = async () => {}
  const enospc = async () => {
    attempts += 1
    if (kernelFull) await fs.writeFile('/dev/full', 'inert transcript storage probe')
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  }
  const io = {
    ...fs,
    rename: async (source, destination) => { await fs.rename(source, destination); await onRename(destination) },
    unlink: async () => { throw noEntry() },
    rm: async () => { throw new Error('Deletion is forbidden in this retained fixture') },
    writeFile: async (...args) => full ? enospc() : fs.writeFile(...args),
    open: async (...args) => {
      const handle = await fs.open(...args)
      if (args[1] !== 'a') return handle
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        sync: () => handle.sync(),
        writeFile: async text => {
          if (!full) return handle.writeFile(text)
          if (partial) { partial = false; await handle.writeFile(text.slice(0, 3)) }
          return enospc()
        },
      }
    },
  }
  const store = createNodeTranscriptStore({ directory, io, onStorageError: error => errors.push(error) })
  const capture = createNodeTranscriptCapture({ store, onError: error => errors.push(error) })
  capture.bind(binding)
  const accepted = new Set()
  const track = pending => { accepted.add(Promise.resolve(pending)); return pending }
  const retry = async () => {
    const result = await store.retry()
    if (result.durable) await capture.retry({ durable: true })
    return result
  }
  const drained = async () => { await Promise.all([...accepted]) }
  t.after(async () => { full = false; await retry(); await drained() })
  return {
    directory, store, capture, errors,
    observeRename(callback) { onRename = callback },
    get attempts() { return attempts },
    full(value, partialWrite = false) { full = value; partial = partialWrite },
    packet: event => track(capture.packet({ sessionId: binding.sessionId, event })),
    accept: request => track(capture.recordAcceptedTranscriptSend(request)), retry, drained,
    async settled() {
      // Observe the real asynchronous capture boundary without letting a
      // baseline refusal mask the retention assertion below.
      try { await capture.flushNode(binding) } catch { }
    },
  }
}

test('ENOSPC retains the accepted words and picture metadata on the real store path', async t => {
  const f = await fixture(t)
  f.full(true)
  const text = 'Keep these synthetic words and this picture.'
  const attachments = [{ name: 'fixture-picture.png', bytes: 93 }]
  f.accept({ sessionId: binding.sessionId, turnId: 'first', text, attachments })
  await f.settled()
  const page = await f.store.read(binding)
  assert.equal(page.entries.find(entry => entry.who === 'you')?.text, text)
  assert.deepEqual(page.entries.find(entry => entry.who === 'you')?.attachments, attachments)
  assert.deepEqual(f.capture.bindingFor(binding.sessionId), { computerId: binding.computerId, nodeId: binding.nodeId })
  assert.equal(page.durable, false, 'memory retention must not claim a durable save')
})

test('partial spill ENOSPC retains each streamed byte once and the session continues', async t => {
  const f = await fixture(t)
  await f.packet({ type: 'assistant_text_delta', turnId: 'first', text: 'Already saved. ' })
  f.full(true, true)
  const held = f.packet({ type: 'assistant_text_delta', turnId: 'first', text: 'Retained after failure. ' })
  await f.settled()
  const later = f.packet({ type: 'assistant_text_delta', turnId: 'first', text: 'Still running.' })
  const completed = f.packet({ type: 'turn_completed', turnId: 'first', status: 'completed' })
  // T1628's lossless producer contract pauses admission after the refusing
  // event. Prove both the pause and the same complete byte sequence on retry.
  const paused = await f.store.read(binding)
  assert.equal(paused.entries.find(entry => entry.who === 'agent')?.text,
    'Already saved. Retained after failure. ')
  assert.ok(f.capture.bindingFor(binding.sessionId), 'storage failure cannot retire the session')
  f.full(false)
  await f.retry()
  await Promise.all([held, later, completed])
  const page = await f.store.read(binding)
  assert.equal(page.entries.find(entry => entry.who === 'agent')?.text,
    'Already saved. Retained after failure. Still running.')
})

test('one disk refusal is retained across reads and renderer client remounts without write retries', async t => {
  const f = await fixture(t)
  f.full(true)
  f.accept({ sessionId: binding.sessionId, turnId: 'first', text: 'Retain me.' })
  await f.settled()
  const attempts = f.attempts
  for (let index = 0; index < 20; index += 1) {
    f.packet({ type: 'assistant_text_delta', turnId: 'first', text: String(index) + ' ' })
    await f.settled()
  }
  assert.equal(f.attempts, attempts, 'a known full disk must not be retried on every output packet')
  assert.equal(f.errors.length, 1, 'one outage must produce one storage notice')
  for (let mount = 0; mount < 2; mount += 1) {
    const messages = []
    const client = createNodeTranscriptClient({ computerId: binding.computerId, bridge: f.store,
      onError: message => messages.push(message) })
    await client.ready
    await client.readLatest(binding.nodeId)
    await client.readLatest(binding.nodeId)
    assert.equal(messages.length, 1, 'reads must keep one visible refusal instead of repeating or clearing it')
    assert.match(messages[0], /disk.*full/i)
    assert.match(messages[0], /memory|not.*saved|not.*disk/i)
    assert.equal(client.get(binding.nodeId).lines.find(entry => entry.who === 'you').text, 'Retain me.')
    client.dispose()
  }
})

test('explicit save retry persists held words once after space returns', async t => {
  const f = await fixture(t)
  f.full(true)
  f.accept({ sessionId: binding.sessionId, turnId: 'first',
    text: 'The accepted question.', attachments: [{ name: 'retained.png', bytes: 71 }] })
  f.packet({ type: 'assistant_text_delta', turnId: 'first', text: 'An answer kept in memory.' })
  f.packet({ type: 'turn_completed', turnId: 'first', status: 'completed' })
  await f.settled()
  f.full(false)
  const result = await f.retry()
  assert.equal(result.ok, true)
  assert.equal(result.durable, true)
  await f.drained()
  await f.capture.shutdown()
  await f.store.shutdown()
  const reopened = createNodeTranscriptStore({ directory: f.directory })
  const page = await reopened.read(binding)
  assert.deepEqual(page.entries.map(entry => entry.text), ['The accepted question.', 'An answer kept in memory.'])
  assert.deepEqual(page.entries[0].attachments, [{ name: 'retained.png', bytes: 71 }])
})

test('Linux kernel ENOSPC remains a caught storage refusal, not a session exit', {
  skip: process.platform !== 'linux' ? 'Kernel full-device proof requires Linux; portable ENOSPC cases above still apply.' : false,
}, async t => {
  const f = await fixture(t, { kernelFull: true })
  f.full(true)
  f.accept({ sessionId: binding.sessionId, turnId: 'kernel-full', text: 'Kernel full device retained text.' })
  await f.settled()
  assert.equal(f.attempts, 1)
  const page = await f.store.read(binding)
  assert.equal(page.entries[0]?.text, 'Kernel full device retained text.')
  assert.ok(f.capture.bindingFor(binding.sessionId))
  assert.equal(page.durable, false)
})


test('legacy migration holds its words and remains readable when the first disk write fails', async t => {
  const f = await fixture(t)
  f.full(true)
  const messages = []
  const legacy = { get: id => id === binding.nodeId
    ? { lines: [{ id: 'legacy-question', who: 'you', text: 'Keep the legacy question.' }], provider: 'local' } : null }
  const client = createNodeTranscriptClient({ computerId: binding.computerId, bridge: f.store,
    nodeIds: [binding.nodeId], legacy, onError: message => messages.push(message) })
  await client.ready
  assert.equal(client.get(binding.nodeId).lines[0]?.text, 'Keep the legacy question.')
  const page = await f.store.read(binding)
  assert.equal(page.durable, false)
  assert.equal(page.metadata.legacyMigrated, true)
  assert.equal(messages.length, 1)
  client.dispose()
})

test('an explicit retry makes a new conversation discoverable before saving its entries', async t => {
  const f = await fixture(t)
  f.full(true)
  f.accept({ sessionId: binding.sessionId, turnId: 'first', text: 'Discoverable retry.' })
  await f.settled()
  f.full(false)
  let sawEntryWrite = false
  f.observeRename(async destination => {
    if (!/\d{16}-[a-f0-9]{64}\.json$/.test(destination)) return
    sawEntryWrite = true
    const reopened = createNodeTranscriptStore({ directory: f.directory })
    const listed = await reopened.list({ computerId: binding.computerId })
    assert.equal(listed.records.find(row => row.nodeId === binding.nodeId)?.nodeId, binding.nodeId,
      'entry files must not become unreachable if the process stops before the next write')
  })
  assert.equal((await f.retry()).ok, true)
  assert.equal(sawEntryWrite, true)
})

test('quit is refused before a window or session closes while accepted words exist only in memory', async t => {
  const { createAppQuitGate } = require('../../shell/app-shutdown.cjs')
  const f = await fixture(t)
  f.full(true)
  f.accept({ sessionId: binding.sessionId, text: 'Keep this through a refused quit.' })
  await f.settled()
  let closed = 0, shutdown = 0, refusals = 0
  const quit = createAppQuitGate({
    getWindows: () => [{ isDestroyed: () => false, close() { closed += 1 } }],
    shutdown: { started: false, beforeQuit() { shutdown += 1 } },
    canClose: () => f.store.getStorageStatus?.().durable !== false,
    onRefusal: () => { refusals += 1 },
  })
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
  const first = event()
  quit(first)
  assert.equal(first.prevented, true)
  assert.equal(closed, 0, 'the memory-held conversation needs its window to stay open')
  assert.equal(shutdown, 0)
  assert.equal(refusals, 1)
  assert.ok(f.capture.bindingFor(binding.sessionId))
  assert.equal((await f.store.read(binding)).entries[0].text, 'Keep this through a refused quit.')
  f.full(false)
  await f.retry()
  quit(event())
  assert.equal(closed, 1, 'saving releases the ordinary close path')
})
