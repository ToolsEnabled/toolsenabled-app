import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchLiveLedger } from '../../src/ledger-live.js'

test('independent ledger reads start together and still report each failure separately', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch
  const questions = Promise.withResolvers(), ledger = Promise.withResolvers()
  let requests = 0, questionReads = 0
  globalThis.fetch = () => { questionReads++; return questions.promise }
  globalThis.window = { mcAgent: { ledger: options => {
    requests++
    assert.deepEqual(options, { scope: 'tree', key: null, removed: true })
    return ledger.promise
  } } }
  let pending
  try {
    pending = fetchLiveLedger({ scope: 'tree', removed: true })
    assert.equal(questionReads, 2, 'the report and its schema still load')
    assert.equal(requests, 1, 'the canonical ledger must not wait for the build-time questions file')
    ledger.reject(new Error('ledger unavailable'))
    // Complete on a later task: an early failed ledger request must already
    // have its rejection handled while the questions response is pending.
    await new Promise(resolve => setImmediate(resolve))
    questions.reject(new Error('questions unavailable'))
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AGENT_LEDGER_UNREADABLE')
    assert.equal(result.reason, 'ledger unavailable')
    assert.equal(result.questions.ok, false)
    assert.match(result.questions.reason, /questions unavailable/)
  } finally {
    questions.resolve({ ok: false, status: 404 })
    ledger.resolve({ ok: false })
    await pending
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})


test('Basic Ledger feed preserves the explicit not-checked history result', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch
  globalThis.window = { mcAgent: { ledger: async () => ({ ok: true, exists: true, revision: 3,
    records: [{ id: 'T1', kind: 'T', words: 'Continue', status: 'open' }],
    chain: { checked: false, ok: null, events: 0, drift: [], missing: [], unchained: [], code: null } }) } }
  globalThis.fetch = async () => ({ ok: false, status: 404 })
  try {
    const read = await fetchLiveLedger()
    assert.equal(read.ok, true)
    assert.equal(read.data.requests.length, 1)
    assert.equal(read.data.chain.checked, false)
    assert.equal(read.data.chain.ok, null, 'not checked is not verified success or corruption')
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch }
})
