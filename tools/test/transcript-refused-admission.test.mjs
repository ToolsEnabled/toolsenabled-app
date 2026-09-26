import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const binding = { computerId: 'inert-computer', nodeId: 'inert-node' }

async function fixture(t, code = 'ENOSPC') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-refused-transcript-admission-'))
  t.diagnostic('RETAINED_REFUSED_ADMISSION ' + directory)
  let full = true, attempts = 0
  const notices = []
  const io = { ...fs,
    unlink: async () => { throw Object.assign(new Error('Retained fixture'), { code: 'ENOENT' }) },
    rm: async () => { throw new Error('Retained fixture deletion refused') },
    writeFile: async (...args) => {
      attempts++
      if (full) throw Object.assign(new Error('Synthetic write refusal'), { code })
      return fs.writeFile(...args)
    },
  }
  const store = createNodeTranscriptStore({ directory, io, onStorageError: error => notices.push(error.code) })
  return { store, notices, attempts: () => attempts, recover: () => { full = false } }
}
const prompt = (id, text, nodeId = binding.nodeId) =>
  ({ ...binding, nodeId, entries: [{ id, who: 'you', text, attachments: [{ name: 'inert.png', bytes: 17 }] }] })

for (const code of ['ENOSPC', 'EIO', 'PROVIDER_CUSTOM_WRITE_FAILURE']) test(code + ' refuses ordinary append, text, migration and metadata after the first held save', async t => {
  const f = await fixture(t, code)
  await f.store.append(prompt('first', 'Already accepted before the failure.'))
  const before = f.store.getStorageStatus()
  const request = prompt('next', 'Keep this in the caller composer.', 'other-node')
  request.accepted = true // A renderer field cannot opt into the internal capture path.
  const original = structuredClone(request)
  const refusal = { code: code === 'ENOSPC' ? 'MC_TRANSCRIPT_DISK_FULL' : 'MC_TRANSCRIPT_STORAGE_FAILED' }
  await assert.rejects(f.store.append(request), refusal)
  await assert.rejects(f.store.appendText({ ...binding, entryId: 'next', text: 'Unadmitted output.' }), refusal)
  await assert.rejects(f.store.migrate(request), refusal)
  await assert.rejects(f.store.bindSessionMetadata({ ...binding, nodeId: 'other-node', sessionId: 'inert-session', replace: true,
    metadata: { threadId: 'inert-thread', provider: 'local', account: null } }), refusal)
  assert.deepEqual(request, original)
  assert.equal(f.store.getStorageStatus().retainedBytes, before.retainedBytes)
  assert.equal(f.attempts(), 1)
  assert.equal(f.notices.length, 1)
  f.recover()
  assert.equal((await f.store.retry()).durable, true)
  await f.store.append(request)
  assert.deepEqual((await f.store.read({ ...binding, nodeId: 'other-node' })).entries.map(row => row.text), ['Keep this in the caller composer.'])
})

test('queued ordinary writes recheck refusal before changing retained state', async t => {
  const f = await fixture(t)
  const first = f.store.append(prompt('first', 'Accepted first.'))
  const later = f.store.append(prompt('later', 'Not accepted by the store.'))
  const result = await Promise.allSettled([first, later])
  assert.equal(result[0].status, 'fulfilled')
  assert.equal(result[1].status, 'rejected')
  assert.equal(result[1].reason.code, 'MC_TRANSCRIPT_DISK_FULL')
  assert.deepEqual((await f.store.read(binding)).entries.map(row => row.text), ['Accepted first.'])
})

test('the internal capture admission preserves an already accepted event after an unrelated save fails', async t => {
  const f = await fixture(t)
  await f.store.append(prompt('first', 'Accepted before the failure.'))
  const request = prompt('accepted', 'Accepted by the producer before the failure.', 'accepted-node')
  const original = structuredClone(request)
  assert.equal((await f.store.append(request, { accepted: true })).durable, false)
  await f.store.appendText({ ...binding, nodeId: 'accepted-node', entryId: 'reply', text: 'Accepted reply.' }, { accepted: true })
  assert.deepEqual(request, original)
  assert.deepEqual((await f.store.read({ ...binding, nodeId: 'accepted-node' })).entries.map(row => row.text),
    ['Accepted by the producer before the failure.', 'Accepted reply.'])
  assert.equal(f.attempts(), 1)
  f.recover()
  assert.equal((await f.store.retry()).durable, true)
  assert.deepEqual((await f.store.read({ ...binding, nodeId: 'accepted-node' })).entries.map(row => row.text),
    ['Accepted by the producer before the failure.', 'Accepted reply.'])
})
