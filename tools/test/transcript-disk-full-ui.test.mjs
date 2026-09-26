import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocument } from './lib/dom-stand-in.mjs'
import { mountTranscriptHistory } from '../../src/node-transcript-history.js'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

test('client retains a generic storage refusal once and clears it only on confirmed saved state', async () => {
  let notice
  const states = [], errors = []
  const client = createNodeTranscriptClient({ computerId: 'inert-computer',
    bridge: { list: async () => ({ ok: true, records: [] }), onError(callback) { notice = callback } },
    onStorageState: state => states.push(state), onError: error => errors.push(error),
  })
  await client.ready
  const failure = { code: 'MC_TRANSCRIPT_STORAGE_FAILED', message: 'Accepted words could not be saved. Keep ToolsEnabled open.' }
  notice(failure); notice(failure)
  assert.equal(states.length, 1)
  assert.deepEqual(states[0], failure)
  assert.equal(errors.length, 1)
  notice({ durable: true })
  assert.equal(states.at(-1), null)
  assert.equal(errors.length, 1, 'a saved-state notice is not a new error')
})
test('a new client mount reads the retained generic refusal from the real bridge response', async () => {
  const failure = { code: 'MC_TRANSCRIPT_STORAGE_FAILED', message: 'Accepted words remain in memory.' }
  const states = []
  const client = createNodeTranscriptClient({ computerId: 'inert-computer',
    bridge: { list: async () => ({ ok: true, durable: false, storageError: failure, records: [] }) },
    onStorageState: state => states.push(state),
  })
  await client.ready
  assert.deepEqual(states, [failure])
})
const diskError = { code: 'MC_TRANSCRIPT_DISK_FULL', message: 'The disk is full. Conversation changes are kept in memory, not saved to disk. Free disk space, then retry saving. Keep ToolsEnabled open.' }
const settle = () => new Promise(resolve => setImmediate(resolve))
const retryButton = doc => [...doc.body.querySelectorAll('button')].find(button => button.textContent === 'Retry saving')

test('saved conversation keeps the disk refusal visible and retries only on an explicit press', async () => {
  const doc = createDocument()
  let saved = false
  let attempts = 0
  let release
  const ready = new Promise(resolve => { release = resolve })
  const store = {
    readPage: async () => ({ entries: [{ who: 'you', text: 'Held synthetic words.' }], before: null,
      ...(saved ? {} : { storageError: diskError }) }),
    retry: async () => { attempts += 1; await ready; saved = true; return { ok: true, durable: true } },
  }
  mountTranscriptHistory({ host: doc.body, store, nodeId: 'held-node', document: doc })
  doc.body.querySelector('button').click()
  await settle()
  const status = doc.body.querySelector('[role="status"]')
  assert.equal(status.textContent, diskError.message)
  const retry = retryButton(doc)
  assert.ok(retry && !retry.hidden, 'full-disk refusal must have a reachable retry action')
  assert.equal(attempts, 0, 'opening a conversation must not silently retry disk writes')
  retry.click()
  retry.click()
  assert.equal(attempts, 1)
  assert.equal(retry.disabled, true)
  assert.equal(status.textContent, diskError.message, 'the outstanding refusal stays visible while retry waits')
  release()
  await settle()
  await settle()
  assert.equal(status.textContent, 'Saved conversation')
  assert.equal(retryButton(doc), undefined)
  assert.match(doc.body.querySelector('.saved-messages').textContent, /Held synthetic words/)
})

test('a still-full disk preserves its retry action and words after the explicit save refuses', async () => {
  const doc = createDocument()
  const store = {
    readPage: async () => ({ entries: [{ who: 'agent', text: 'Held reply.' }], before: null, storageError: diskError }),
    retry: async () => ({ ok: false, error: diskError }),
  }
  mountTranscriptHistory({ host: doc.body, store, nodeId: 'held-node', document: doc })
  doc.body.querySelector('button').click()
  await settle()
  const retry = retryButton(doc)
  assert.ok(retry, 'the refused save must have an explicit retry action')
  retry.click()
  await settle()
  assert.equal(doc.body.querySelector('[role="status"]').textContent, diskError.message)
  assert.equal(retry.disabled, false)
  assert.match(doc.body.querySelector('.saved-messages').textContent, /Held reply/)
})
