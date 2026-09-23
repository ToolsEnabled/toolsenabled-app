import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { actionRowWords } from '../../src/fleet-tree-copy.js'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const binding = { sessionId: 'synthetic-session', computerId: 'synthetic-computer', nodeId: 'synthetic-node' }

test('host session metadata survives late renderer saves, an old session and disk reopen', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-native-transcript-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const old = { threadId: 'old-thread', provider: 'codex', account: null }
  const current = { threadId: 'current-thread', provider: 'codex', account: 'Exact account' }
  await store.append({ ...binding, entries: [], metadata: old })
  await store.bindSessionMetadata({ ...binding, metadata: current, replace: true })
  await store.append({ ...binding, entries: [{ id: 'late', who: 'agent', text: 'Preserved late history.' }],
    metadata: { ...old, nativeSessionId: 'forged-old-session' } })
  await store.bindSessionMetadata({ ...binding, sessionId: 'old-session', metadata: old })
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory }); t.after(() => reopened.shutdown())
  const saved = await reopened.read(binding)
  assert.equal(saved.metadata.threadId, current.threadId)
  assert.equal(saved.metadata.account, current.account)
  assert.equal(saved.metadata.nativeSessionId, binding.sessionId)
  assert.equal(saved.entries[0].text, 'Preserved late history.')
  await reopened.bindSessionMetadata({ ...binding, metadata: { ...current, threadId: 'rewound-thread' } })
  assert.equal((await reopened.read(binding)).metadata.threadId, 'rewound-thread')
})

test('canonical capture binds native identity before first output and ignores an old session update', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-capture-binding-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  let threadId = 'native-thread'
  const capture = createNodeTranscriptCapture({ store, sessionMetadata: () => ({ threadId, provider: 'codex', account: 'Exact account' }) })
  capture.bind({ ...binding, authoritative: true })
  await capture.flushNode(binding)
  assert.equal((await store.read(binding)).metadata.threadId, threadId)
  threadId = 'rewound-native-thread'
  capture.packet({ sessionId: binding.sessionId, event: { type: 'turn_accepted', turnId: 'one' } })
  await capture.flushNode(binding)
  assert.equal((await store.read(binding)).metadata.threadId, threadId)
  await capture.shutdown(); await store.shutdown()
})

test('a failed host metadata save retries on real output and clears its recovered flush failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-capture-retry-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const original = store.bindSessionMetadata
  let attempts = 0
  store.bindSessionMetadata = request => ++attempts === 1 ? Promise.reject(new Error('Temporary disk failure.')) : original(request)
  const metadata = { threadId: 'current-native', provider: 'claude', account: 'Exact account' }
  const capture = createNodeTranscriptCapture({ store, sessionMetadata: () => metadata })
  capture.bind({ ...binding, authoritative: true })
  await assert.rejects(capture.flushNode(binding), /Temporary disk failure/)
  assert.equal((await store.read(binding)).metadata?.threadId, undefined)
  capture.packet({ sessionId: binding.sessionId, event: { type: 'assistant_text', turnId: 'one', text: 'Actual output.' } })
  await capture.flushNode(binding)
  assert.equal(attempts, 2)
  assert.equal((await store.read(binding)).metadata.threadId, metadata.threadId)
  assert.equal((await store.read(binding)).metadata.nativeSessionId, binding.sessionId)
  await capture.shutdown(); await store.shutdown()
})

test('retrying a superseded host session cannot reclaim the new session metadata', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-capture-superseded-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const original = store.bindSessionMetadata
  let failed = false
  store.bindSessionMetadata = request => {
    if (!failed) { failed = true; return Promise.reject(new Error('Temporary disk failure.')) }
    return original(request)
  }
  const capture = createNodeTranscriptCapture({ store, sessionMetadata: sessionId => ({ threadId: sessionId + '-native', provider: 'codex', account: 'Exact account' }) })
  capture.bind({ ...binding, authoritative: true })
  await assert.rejects(capture.flushNode(binding), /Temporary disk failure/)
  capture.bind({ ...binding, sessionId: 'replacement', authoritative: true })
  capture.packet({ sessionId: binding.sessionId, event: { type: 'turn_accepted', turnId: 'late' } })
  await capture.flushNode(binding)
  assert.equal((await store.read(binding)).metadata.threadId, 'replacement-native')
  assert.equal((await store.read(binding)).metadata.nativeSessionId, 'replacement')
  await capture.shutdown(); await store.shutdown()
})

test('legacy migration cannot mint renderer authority or replace an existing host binding', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-migrate-binding-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory }); t.after(() => store.shutdown())
  const metadata = { nativeSessionId: 'renderer-spoof', threadId: 'legacy-thread', provider: 'codex', account: null }
  await store.migrate({ ...binding, entries: [], metadata })
  assert.equal((await store.read(binding)).metadata.nativeSessionId, undefined)
  const other = { ...binding, nodeId: 'other-node' }
  await store.bindSessionMetadata({ ...other, metadata: { threadId: 'host-native', provider: 'claude', account: 'Exact account' }, replace: true })
  await store.migrate({ ...other, entries: [], metadata })
  const saved = (await store.read(other)).metadata
  assert.equal(saved.nativeSessionId, binding.sessionId)
  assert.equal(saved.threadId, 'host-native'); assert.equal(saved.account, 'Exact account')
})

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-terminal-transcript-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store })
  capture.bind(binding)
  return {
    store, capture, directory,
    packet: event => capture.packet({ sessionId: binding.sessionId, event }),
    async reopen() {
      await capture.shutdown()
      await store.shutdown()
      const reopened = createNodeTranscriptStore({ directory })
      t.after(() => reopened.shutdown())
      const client = createNodeTranscriptClient({ computerId: binding.computerId, bridge: reopened })
      await client.ready
      t.after(() => client.dispose())
      return (await client.readLatest(binding.nodeId))?.lines || []
    },
  }
}

test('renderer-absent provider failure survives canonical disk reopen as an action, not assistant speech', async t => {
  const h = await harness(t)
  await h.capture.recordAcceptedTranscriptSend({ sessionId: binding.sessionId, turnId: 'turn', text: 'Synthetic request.' })
  h.packet({ type: 'turn_completed', turnId: 'turn', status: 'error', text: 'Synthetic provider error.' })
  const lines = await h.reopen()
  assert.equal(lines.length, 2, 'canonical capture omitted the terminal-only failure')
  assert.equal(lines[1].who, 'action')
  assert.equal(lines[1].tool, 'Turn')
  assert.equal(lines[1].state, 'undone')
  assert.match(lines[1].text, /did not finish/i)
  assert.doesNotMatch(JSON.stringify(lines), /Synthetic provider error/)
})

test('partial speech is preserved before one idempotent failure outcome, and the next turn is unaffected', async t => {
  const h = await harness(t)
  h.packet({ type: 'assistant_text_delta', turnId: 'first', text: 'Partial answer.' })
  h.packet({ type: 'assistant_text', turnId: 'first', text: 'Partial answer.' })
  const terminal = { type: 'turn_completed', turnId: 'first', status: 'error', text: 'Synthetic error.' }
  h.packet(terminal)
  h.packet(terminal)
  h.packet({ type: 'assistant_text', turnId: 'next', text: 'Next answer.' })
  h.packet({ type: 'turn_completed', turnId: 'next', status: 'success', text: 'Next answer.' })
  const lines = await h.reopen()
  assert.deepEqual(lines.map(line => line.who), ['agent', 'action', 'agent'])
  assert.equal(lines[0].text, 'Partial answer.')
  assert.equal(lines[2].text, 'Next answer.')
})

for (const status of ['cancelled', 'end_turn']) {
  test(`a named final message after a tool does not duplicate its streamed speech on ${status} and disk reopen`, async t => {
    const h = await harness(t)
    const itemId = 'acp-assistant-first'
    h.packet({ type: 'assistant_text_delta', turnId: 'first', itemId, text: 'Looking up the tool.' })
    h.packet({ type: 'tool_call', turnId: 'first', toolCallId: 'lookup', tool: 'search' })
    h.packet({ type: 'assistant_text_delta', turnId: 'first', itemId, text: 'Requesting permission.' })
    h.packet({ type: 'approval_request', turnId: 'first', approval: { approvalId: 'permission' } })
    // Actual ACP emits one final item containing all deltas even when Refuse
    // or Stop ends the prompt before another assistant chunk follows the tool.
    h.packet({ type: 'assistant_text', turnId: 'first', itemId, text: 'Looking up the tool.Requesting permission.' })
    h.packet({ type: 'turn_completed', turnId: 'first', status })
    const lines = await h.reopen()
    assert.equal(lines.filter(line => line.who === 'agent').length, 1)
    assert.equal(lines.find(line => line.who === 'agent').text, 'Looking up the tool.\n\nRequesting permission.')
  })
}

test('named streamed items do not hide a different full-only message or the next turn', async t => {
  const h = await harness(t)
  h.packet({ type: 'assistant_text_delta', turnId: 'first', itemId: 'one', text: 'First message.' })
  h.packet({ type: 'tool_call', turnId: 'first', toolCallId: 'tool', tool: 'search' })
  h.packet({ type: 'assistant_text', turnId: 'first', itemId: 'two', text: 'Different full message.' })
  h.packet({ type: 'assistant_text', turnId: 'first', itemId: 'one', text: 'First message.' })
  h.packet({ type: 'turn_completed', turnId: 'first', status: 'completed' })
  h.packet({ type: 'assistant_text', turnId: 'second', itemId: 'one', text: 'Next turn.' })
  h.packet({ type: 'turn_completed', turnId: 'second', status: 'success' })
  const lines = (await h.reopen()).filter(line => line.who === 'agent')
  assert.deepEqual(lines.map(line => line.text), ['First message.\n\nDifferent full message.', 'Next turn.'])
})

test('only fixed limit classifications cross the diagnostic boundary; arbitrary text and credentials do not', async t => {
  const h = await harness(t)
  const diagnostics = [
    { status: 'failed', text: 'Context window exceeded. token=synthetic-private' },
    { status: 'error', code: 'usage_limit_reached', text: 'Bearer synthetic-private' },
    { status: 'error', text: 'TypeError: synthetic-private is not a function\n at f (/synthetic/private:1)' },
    { status: 'error', text: 'Request failed with password=synthetic-private api_key=synthetic-private' },
    { status: 'error', text: 'Bearer synthetic-private '.repeat(10000) },
    { status: 'error', text: { credential: 'synthetic-private' }, error: { message: 'synthetic-private' } },
  ]
  diagnostics.forEach((diagnostic, i) => h.packet({ type: 'turn_completed', turnId: `turn-${i}`,
    recoveryFiles: ['/synthetic/private'], ...diagnostic }))
  const lines = await h.reopen()
  assert.equal(lines.length, diagnostics.length)
  assert.match(lines[0].text, /provider reported a context limit/)
  assert.match(lines[1].text, /provider reported an account usage limit/)
  for (const line of lines) {
    assert.equal(line.who, 'action')
    assert.ok(line.text.length <= 100)
    assert.deepEqual(Object.keys(line).sort(), ['at', 'id', 'kind', 'recoveryFiles', 'state', 'text', 'tool', 'turnStamp', 'who'])
    assert.equal(line.kind, 'turn')
    assert.match(line.turnStamp, /^turn-\d+$/)
    const digest = value => createHash('sha256').update(value).digest('hex')
    const folder = path.join(h.directory, 'node-transcripts', 'active', `${digest(binding.computerId)}-${digest(binding.nodeId)}`)
    assert.equal(line.recoveryFiles.length, 1, 'bounded terminal entries need only their existing JSON file')
    const file = line.recoveryFiles[0]
    assert.equal(path.dirname(await fs.realpath(file)), folder, 'the locator belongs to this node and this private store')
    assert.ok(path.basename(file).endsWith(`-${digest(line.id)}.json`), 'the locator identifies this exact entry')
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'))
    const { recoveryFiles, ...projected } = line
    assert.deepEqual(persisted, projected, 'recovery paths are derived at read time, not accepted from the event')
  }
  assert.doesNotMatch(JSON.stringify(lines), /synthetic-private|Bearer|api_key|credential|TypeError/)
})

test('success creates no duplicate speech or false failure; canceled and unknown outcomes are not called success', async t => {
  const h = await harness(t)
  for (const [index, status] of ['completed', 'success', 'end_turn', 'cancelled', 'interrupted', undefined, 'future-provider-outcome'].entries()) {
    h.packet({ type: 'turn_completed', turnId: `turn-${index}`, status, text: 'Untrusted result.' })
  }
  h.packet({ type: 'turn_failed', turnId: 'explicit-failed' })
  const lines = await h.reopen()
  assert.equal(lines.length, 5)
  assert.equal(lines[0].text, 'Turn stopped before completion.')
  assert.equal(lines[1].text, 'Turn stopped before completion.')
  assert.equal(lines[2].text, 'Turn ended without a confirmed successful outcome.')
  assert.equal(lines[3].text, 'Turn ended without a confirmed successful outcome.')
  assert.match(lines[4].text, /did not finish/)
  assert.doesNotMatch(JSON.stringify(lines), /Untrusted|Stopped by you/)
})

test('the actual saved-history projection keeps the terminal action distinct from assistant speech', async t => {
  const h = await harness(t)
  h.packet({ type: 'turn_completed', turnId: 'failed', status: 'error' })
  const [entry] = await h.reopen()
  const source = await fs.readFile(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  let actual
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'savedActionRow') actual = node
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  assert.ok(actual, 'the actual canonical history action projector must exist')
  const savedActionRow = vm.runInNewContext(`(${source.slice(actual.start, actual.end)})`, {
    actionRowWords, actionTimingFields: () => ({}),
  })
  const projected = savedActionRow(entry, 0)
  assert.equal(projected.who, 'action')
  assert.equal(projected.tool, 'Turn')
  assert.equal(projected.detail, entry.text)
  assert.equal(projected.state, 'did not finish')
  assert.equal(projected.stateKey, 'undone')
  assert.equal(projected.body, '', 'there is no hidden diagnostic payload')
})

test('unbound, unnamed, ended, and unrelated packets cannot write a terminal entry', async t => {
  const h = await harness(t)
  h.capture.packet({ sessionId: 'foreign', event: { type: 'turn_completed', turnId: 'turn', status: 'error' } })
  h.packet({ type: 'turn_completed', status: 'error' })
  h.packet({ type: 'tool_result', turnId: 'turn', status: 'error' })
  h.packet({ type: 'session_ended' })
  h.packet({ type: 'turn_completed', turnId: 'turn', status: 'error' })
  assert.deepEqual(await h.reopen(), [])
})

test('terminal writes participate in flushNode and shutdown failure reporting', async () => {
  const failure = new Error('Synthetic disk failure.')
  const observed = []
  const capture = createNodeTranscriptCapture({
    store: { append: async () => { throw failure } },
    onError: error => observed.push(error),
  })
  capture.bind(binding)
  capture.packet({ sessionId: binding.sessionId, event: { type: 'turn_failed', turnId: 'failed' } })
  await assert.rejects(capture.flushNode(binding), error => error === failure)
  await assert.rejects(capture.shutdown(), error => error === failure)
  assert.deepEqual(observed, [failure])
})

test('a late host acceptance after session end is recorded, while late assistant packets stay ignored', async t => {
  const h = await harness(t)
  h.packet({ type: 'session_ended' })
  h.packet({ type: 'assistant_text_delta', turnId: 'late', text: 'LATE_OUTPUT_MUST_NOT_REVIVE' })
  const text = 'Accepted before the closed response returned.'
  await h.capture.recordAcceptedTranscriptSend({ sessionId: binding.sessionId, text, turnId: 'late',
    transcriptPrompt: { text, additions: [{ kind: 'role', text: 'Actually consumed role text.' }] } })
  const lines = await h.reopen()
  assert.deepEqual(lines.map(line => line.text), [text, 'Actually consumed role text.'])
  assert.equal(lines[1].promptKind, 'role')
  assert.doesNotMatch(JSON.stringify(lines), /LATE_OUTPUT_MUST_NOT_REVIVE/)
})

/* T406: AN IDENTITY THAT CANNOT BE RESOLVED IS A NAMED REFUSAL, NOT A TypeError.
   Measured 2026-09-18 on the 3e1cd3a9 candidate: mcTranscripts.list() with no
   request answered "Cannot destructure property 'computerId' of 'undefined'",
   which shell/main.cjs dressed as MC_TRANSCRIPT_STORAGE_FAILED. Storage had
   not failed; nobody had said whose transcript was wanted. */
const IDENTITY_UNRESOLVED = 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED'
const namedIdentityRefusal = field => error => {
  assert.notEqual(error?.constructor, TypeError, `a missing ${field} must not surface as a TypeError: ${error?.message}`)
  assert.equal(error?.code, IDENTITY_UNRESOLVED, `the refusal names itself: ${error?.message}`)
  assert.equal(error?.field, field)
  assert.match(error?.message || '', new RegExp(field), 'the sentence names the missing half')
  return true
}

test('list() on an unresolvable identity refuses by name and lists nothing else', async t => {
  const h = await harness(t)
  /* A bound, written node exists, so the refusal cannot be mistaken for
     "there was nothing to list". */
  h.packet({ type: 'assistant_text_delta', turnId: 'turn', text: 'Something was said.' })
  h.packet({ type: 'turn_completed', turnId: 'turn', status: 'completed' })
  await h.capture.flushNode(binding)
  const listed = await h.store.list({ computerId: binding.computerId })
  assert.equal(listed.ok, true)
  assert.equal(listed.records.length, 1, 'the control: a resolved identity lists the node')
  await assert.rejects(h.store.list(), namedIdentityRefusal('computerId'))
  await assert.rejects(h.store.list({}), namedIdentityRefusal('computerId'))
  await assert.rejects(h.store.list({ computerId: '' }), namedIdentityRefusal('computerId'))
  await assert.rejects(h.store.list({ computerId: 42 }), namedIdentityRefusal('computerId'))
  await assert.rejects(h.store.list(null), namedIdentityRefusal('computerId'))
})

test('every per-node operation refuses an unresolvable identity by name, naming which half', async t => {
  const h = await harness(t)
  for (const operation of ['read', 'append', 'archive', 'rollback', 'migrate']) {
    await assert.rejects(h.store[operation](), namedIdentityRefusal('computerId'))
    await assert.rejects(h.store[operation]({ nodeId: binding.nodeId }), namedIdentityRefusal('computerId'))
    await assert.rejects(h.store[operation]({ computerId: binding.computerId }), namedIdentityRefusal('nodeId'))
  }
  /* A capture binding with no session, computer or node is the same refusal. */
  assert.throws(() => h.capture.bind(), namedIdentityRefusal('sessionId'))
  assert.throws(() => h.capture.bind({ sessionId: 's', nodeId: 'n' }), namedIdentityRefusal('computerId'))
  assert.throws(() => h.capture.bind({ sessionId: 's', computerId: 'c' }), namedIdentityRefusal('nodeId'))
  /* And a fully named identity still works after all of that: the refusals
     changed no state. */
  assert.equal(h.capture.bind({ sessionId: 'other-session', computerId: binding.computerId, nodeId: 'other-node' }).ok, true)
  assert.equal((await h.store.read({ computerId: binding.computerId, nodeId: binding.nodeId, limit: 5 })).ok, true)
})

/* T1509. A USAGE LIMIT IN THE SAVED CONVERSATION SAYS SO, AND WHEN IT ENDS.
   The recorded ending: on 2026-09-22 at 12:01Z thirty-seven Codex turns
   stopped on a weekly limit whose reset the provider named as Sep 29 2:13 AM
   (the owner's clock, America/Los_Angeles). Every saved conversation said only
   "Turn did not finish. No safe failure detail was recorded." The events below
   are the shape the engine emits for that ending (engine test
   codex-turn-failure-details: the recorded usage-limit ending), with and
   without a reset it could read. */
const RECORDED_AT = Date.parse('2026-09-22T12:01:16Z')
async function clockedHarness(t, nowMs = RECORDED_AT) {
  const previousTz = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  t.after(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-usage-limit-transcript-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store, now: () => nowMs })
  capture.bind(binding)
  return {
    packet: event => capture.packet({ sessionId: binding.sessionId, event }),
    async reopen() {
      await capture.shutdown(); await store.shutdown()
      const reopened = createNodeTranscriptStore({ directory }); t.after(() => reopened.shutdown())
      const client = createNodeTranscriptClient({ computerId: binding.computerId, bridge: reopened })
      await client.ready; t.after(() => client.dispose())
      return (await client.readLatest(binding.nodeId))?.lines || []
    },
  }
}

test('a recorded usage-limit ending is saved with the limit, its reset time and where to choose another account', async t => {
  const h = await clockedHarness(t)
  h.packet({ type: 'assistant_text', turnId: 'limited', text: 'Partial answer before the limit.' })
  h.packet({ type: 'turn_completed', threadId: 'thread-1', turnId: 'limited', status: 'failed',
    text: 'This Codex account has reached its usage limit. The limit resets Sep 29, 2:13 AM. Until then, choose another account in the Accounts menu.',
    payload: { limit: 'usage', resetsAt: '2026-09-29T09:13:00.000Z' } })
  const lines = await h.reopen()
  assert.deepEqual(lines.map(line => line.who), ['agent', 'action'])
  assert.equal(lines[0].text, 'Partial answer before the limit.')
  assert.equal(lines[1].tool, 'Turn')
  assert.equal(lines[1].state, 'undone')
  assert.equal(lines[1].text, 'Account usage limit reached. It resets Sep 29, 2:13 AM. Until then, choose another account in the Accounts menu.')
  assert.doesNotMatch(JSON.stringify(lines), /No safe failure detail/)
  /* The chat draws this as one row cut to the rail's width under "Turn · did not
     finish": the limit leads, so it is what stays in view. */
  assert.ok(lines[1].text.indexOf('usage limit') >= 0 && lines[1].text.indexOf('usage limit') < 16, 'the usage limit leads the line')
})

test('a usage-limit ending whose reset could not be read still names the limit and the Accounts menu', async t => {
  const h = await clockedHarness(t)
  h.packet({ type: 'turn_completed', turnId: 'limited', status: 'failed',
    text: 'This Codex account has reached its usage limit. Wait for its allowance to reset or choose another account.',
    payload: { limit: 'usage' } })
  const [line] = await h.reopen()
  assert.equal(line.text, 'Account usage limit reached. Wait for it to reset or choose another account in the Accounts menu.')
})

test('a reset instant that is malformed, long past or years away is not written as a time', async t => {
  const h = await clockedHarness(t)
  const forged = ['Sep 29th, 2026 2:13 AM', 'https://chatgpt.com/codex/settings/usage', '2026-09-29T09:13:00.000Z sk-private',
    '2020-09-29T09:13:00.000Z', '2031-09-29T09:13:00.000Z', 1790000000000, { at: '2026-09-29T09:13:00.000Z' }]
  forged.forEach((resetsAt, i) => h.packet({ type: 'turn_completed', turnId: `forged-${i}`, status: 'failed',
    payload: { limit: 'usage', resetsAt } }))
  const lines = await h.reopen()
  assert.equal(lines.length, forged.length)
  for (const line of lines) {
    assert.equal(line.text, 'Account usage limit reached. Wait for it to reset or choose another account in the Accounts menu.')
  }
  assert.doesNotMatch(JSON.stringify(lines), /chatgpt|sk-private|2031|2020|Sep 29/)
})

test('a usage-limit payload on a turn that succeeded or was stopped writes no limit line, and another payload is not a limit', async t => {
  const h = await clockedHarness(t)
  const payload = { limit: 'usage', resetsAt: '2026-09-29T09:13:00.000Z' }
  h.packet({ type: 'turn_completed', turnId: 'done', status: 'completed', payload })
  h.packet({ type: 'turn_completed', turnId: 'stopped', status: 'interrupted', payload })
  h.packet({ type: 'turn_completed', turnId: 'other', status: 'failed', payload: { limit: 'context', resetsAt: payload.resetsAt } })
  h.packet({ type: 'turn_completed', turnId: 'list', status: 'failed', payload: [payload] })
  const lines = await h.reopen()
  assert.deepEqual(lines.map(line => line.text), ['Turn stopped before completion.',
    'Turn did not finish. No safe failure detail was recorded.', 'Turn did not finish. No safe failure detail was recorded.'])
})
