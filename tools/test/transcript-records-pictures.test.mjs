/* A PICTURE THAT RODE A TURN, AND ONE THAT DID NOT, BOTH LEAVE A RECORD.
 *
 * T18. The owner reported that a pasted image "DONT get sent to the agent and
 * cause an error", and a 14,652-byte png was found saved on disk with no
 * transcript row naming an attachment and none naming an error. That was not a
 * coincidence: agent:send wrote a transcript row only on the success path, and
 * that row carried sessionId, text, turnId and nothing about pictures at all.
 * So a delivered picture and a refused one and no picture were the same record.
 *
 * These assertions call the real capture with real values and read what landed
 * on disk.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')

const sessionId = 'd63849e4-c442-4dc6-9eb4-d6bb0c6937bc'
const turnId = '7884fa80-446d-478a-bdb2-ac31a9bb4a2d'
const node = { computerId: 'computer', nodeId: 'local-observer' }

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-pictures-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store })
  capture.bind({ sessionId, ...node })
  return { store, capture }
}

test('a delivered picture is recorded on the turn by name and size, and never by path', async t => {
  const { store, capture } = await fixture(t)
  await capture.recordAcceptedTranscriptSend({
    sessionId, turnId, text: 'what is in this picture?',
    attachments: [{ name: 'pasted-1757900000000.png', bytes: 14652 }]
  })
  await capture.shutdown()
  const raw = await store.read({ ...node })
  const you = raw.entries.find(entry => entry.who === 'you')
  assert.ok(you, 'the turn must still be recorded')
  assert.deepEqual(you.attachments, [{ name: 'pasted-1757900000000.png', bytes: 14652 }])
  const serialised = JSON.stringify(raw.entries)
  assert.ok(!/[A-Za-z]:\\\\|\/home\/|paste-attachments/.test(serialised),
    `no row may carry a path: ${serialised.slice(0, 400)}`)
})

test('a turn with no picture records no attachment field at all', async t => {
  const { store, capture } = await fixture(t)
  await capture.recordAcceptedTranscriptSend({ sessionId, turnId, text: 'just words' })
  await capture.shutdown()
  const you = (await store.read({ ...node })).entries.find(entry => entry.who === 'you')
  assert.equal(you.attachments, undefined,
    'an empty list would make every reader below reason about a picture that is not there')
})

test('a picture the provider cannot take is its own row, in the words the person was shown', async t => {
  const { store, capture } = await fixture(t)
  const sentence = 'The picture holiday.png was not sent: this agent cannot look at pictures, '
    + 'because a local model session in this build takes words only. Your message was sent without it.'
  await capture.recordAcceptedTranscriptSend({
    sessionId, turnId, text: 'what is in this picture?',
    pictureNotSent: { provider: 'local', sentence, attachments: [{ name: 'holiday.png', bytes: 2048 }] }
  })
  await capture.shutdown()
  const entries = (await store.read({ ...node })).entries
  const you = entries.find(entry => entry.who === 'you')
  const note = entries.find(entry => entry.who === 'action')
  assert.ok(you, 'the words still went, so the turn is still recorded')
  assert.equal(you.attachments, undefined,
    'a picture that was not sent must NOT be recorded as having ridden the turn')
  assert.ok(note, 'a refused picture must be a row, not an absence')
  assert.equal(note.state, 'refused')
  assert.equal(note.text, sentence)
  assert.equal(note.provider, 'local')
  assert.deepEqual(note.attachments, [{ name: 'holiday.png', bytes: 2048 }])
  assert.equal(note.turnStamp, turnId, 'the refusal belongs to the turn it happened on')
})

test('a size that could not be measured is left out rather than guessed', async t => {
  const { store, capture } = await fixture(t)
  await capture.recordAcceptedTranscriptSend({
    sessionId, turnId, text: 'look',
    attachments: [{ name: 'unmeasured.png' }, { name: 'bad.png', bytes: -1 }, { name: '', bytes: 5 }, { bytes: 9 }]
  })
  await capture.shutdown()
  const you = (await store.read({ ...node })).entries.find(entry => entry.who === 'you')
  assert.deepEqual(you.attachments, [{ name: 'unmeasured.png' }, { name: 'bad.png' }],
    'a nameless row is dropped and a nonsense size is omitted, not written as a number')
})
