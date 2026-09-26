import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SMOKE_FILE = path.join(ROOT, 'shell', 'agent-host-smoke.cjs')
const HOST_FILE = path.join(ROOT, 'shell', 'agent-host.cjs')

// Mutation audit (CONTRACT/1, 2026-08-28): replacing the assembled reply at
// shell/agent-host-smoke.cjs:52 with the constant "PONG" made the wrong-reply
// case below fail with "a completed turn with the wrong answer was accepted"
// (4 pass, 1 fail). The production module's SHA-256 was
// 248ae54e471c4f9f790594f0c28e02078dd608b75044365c75648604453ccd18 both
// before the mutation and after restoration; both unmutated runs passed 5/5.

async function runSmoke({ events = [], sendError = null } = {}) {
  const calls = { closed: 0, sent: [], started: [], unsubscribed: 0 }
  let listener
  let finishClose
  const closed = new Promise(resolve => { finishClose = resolve })
  const host = {
    onEvent(callback) {
      listener = callback
      return () => { calls.unsubscribed += 1 }
    },
    async startSession(options) { calls.started.push(options) },
    async sendTurn(options) {
      calls.sent.push(options)
      for (const event of events) listener(typeof event === 'function' ? event(options) : event)
      if (sendError) throw sendError
    },
    async closeAll() {
      calls.closed += 1
      finishClose()
    },
  }

  const previousHost = require_.cache[HOST_FILE]
  const previousExitCode = process.exitCode
  const logs = []
  const errors = []
  const originalLog = console.log
  const originalError = console.error
  require_.cache[HOST_FILE] = {
    id: HOST_FILE,
    filename: HOST_FILE,
    loaded: true,
    exports: { createAgentHost: options => {
      calls.hostOptions = options
      return host
    } },
  }
  delete require_.cache[SMOKE_FILE]
  console.log = (...args) => logs.push(args.map(String).join(' '))
  console.error = (...args) => errors.push(args.map(String).join(' '))

  try {
    require_(SMOKE_FILE)
    await closed
    await new Promise(resolve => setImmediate(resolve))
    return { calls, errors, exitCode: process.exitCode, logs }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exitCode = previousExitCode
    delete require_.cache[SMOKE_FILE]
    if (previousHost) require_.cache[HOST_FILE] = previousHost
    else delete require_.cache[HOST_FILE]
  }
}

test('shell/agent-host-smoke.cjs drives one real turn, ignores foreign events, and cleans up', async () => {
  const result = await runSmoke({
    events: [
      options => ({ sessionId: 'some-other-session', event: { type: 'assistant_text_delta', text: 'WRONG' } }),
      options => ({ sessionId: options.sessionId, event: { type: 'assistant_text_delta', text: 'PO' } }),
      options => ({ sessionId: options.sessionId, event: { type: 'assistant_text_delta', text: 'NG' } }),
      options => ({ sessionId: options.sessionId, event: { type: 'turn_completed', status: 'completed' } }),
    ],
  })

  assert.equal(result.errors.length, 0, `a valid streamed turn was refused: ${result.errors.join('\n')}`)
  assert.equal(result.exitCode, undefined, 'a valid streamed turn set a failing process status')
  assert.equal(result.calls.started.length, 1, 'the smoke did not start exactly one session')
  assert.equal(result.calls.sent.length, 1, 'the smoke did not send exactly one turn')
  assert.equal(result.calls.started[0].sessionId, result.calls.sent[0].sessionId,
    'the turn was sent to a different session from the one that was started')
  assert.equal(result.calls.started[0].cwd, ROOT, 'the smoke session does not use the repository as its workspace')
  assert.equal(result.calls.sent[0].text, 'Reply with exactly the word: PONG')
  assert.deepEqual([result.calls.unsubscribed, result.calls.closed], [1, 1],
    'a successful run must release both the event subscription and host')
})

test('shell/agent-host-smoke.cjs refuses a non-completed turn and reports its status', async () => {
  const result = await runSmoke({
    events: [
      options => ({ sessionId: options.sessionId, event: { type: 'assistant_text_delta', text: 'PONG' } }),
      options => ({ sessionId: options.sessionId, event: { type: 'turn_completed', status: 'failed' } }),
    ],
  })

  assert.equal(result.exitCode, 1, 'a failed turn was accepted as a successful smoke run')
  assert.ok(result.errors.some(line => line.includes('Turn did not complete successfully') && line.includes('failed')),
    `the refusal did not carry the failed turn's reason: ${result.errors.join('\n')}`)
  assert.deepEqual([result.calls.unsubscribed, result.calls.closed], [1, 1],
    'a refused turn must still release both the subscription and host')
})

test('shell/agent-host-smoke.cjs requires a streamed delta, not merely a completed status', async () => {
  const result = await runSmoke({
    events: [options => ({ sessionId: options.sessionId, event: { type: 'turn_completed', status: 'completed' } })],
  })

  assert.equal(result.exitCode, 1, 'completion without streamed output was accepted')
  assert.ok(result.errors.some(line => line.includes('No assistant_text_delta events were received')),
    `the refusal did not identify the missing stream: ${result.errors.join('\n')}`)
})

test('shell/agent-host-smoke.cjs rejects the wrong assembled reply and identifies what arrived', async () => {
  const result = await runSmoke({
    events: [
      options => ({ sessionId: options.sessionId, event: { type: 'assistant_text_delta', text: 'NOT PONG' } }),
      options => ({ sessionId: options.sessionId, event: { type: 'turn_completed', status: 'completed' } }),
    ],
  })

  assert.equal(result.exitCode, 1, 'a completed turn with the wrong answer was accepted')
  assert.ok(result.errors.some(line => line.includes('Expected exactly PONG') && line.includes('NOT PONG')),
    `the refusal did not identify the reply that failed validation: ${result.errors.join('\n')}`)
})

test('shell/agent-host-smoke.cjs treats a send failure as unknown, never as a definite pass', async () => {
  const result = await runSmoke({ sendError: new Error('provider could not be read') })

  assert.equal(result.exitCode, 1, 'an unreadable provider result was converted into a successful smoke run')
  assert.ok(result.errors.some(line => line.includes('provider could not be read')),
    `the underlying send failure was not preserved as the refusal reason: ${result.errors.join('\n')}`)
  assert.equal(result.calls.closed, 1, 'the host was not closed after the send failed')
})
