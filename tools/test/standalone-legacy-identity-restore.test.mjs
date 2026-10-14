import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { createLegacyStandaloneTranscriptReader, readSavedStandaloneContinuation } = require('../../shell/legacy-standalone-identity.cjs')
const continuationModule = require('../../../engine/src/lib/agent-continuation-state.js')
const nodeId = 'standalone-12345678-1234-4123-8123-123456789abc'
const request = { computerId: 'fixture-computer', nodeId }
const unavailable = 'AGENT_RESUME_IDENTITY_UNAVAILABLE', mismatch = 'AGENT_RESUME_IDENTITY_MISMATCH'

function fixture(change = () => {}) {
  const state = {
    metadata: { ...request, savedAt: 1 },
    ledger: { v: 1, tabs: [{ id: nodeId, sessionId: 'saved-host', tier: 'astra' }] },
    descriptor: { sessionId: 'saved-host', resumeThreadId: 'saved-thread',
      resumeThreadProvider: 'codex', resumeAccount: 'saved-account',
      roleBinding: { id: 'worker', agentId: nodeId } },
  }
  change(state)
  const entries = [{ id: 'old-word', who: 'agent', text: 'Old conversation words.' }]
  let lookups = 0
  const read = createLegacyStandaloneTranscriptReader({
    readTranscript: async () => ({ ok: true, durable: state.durable ?? true, metadata: state.metadata, entries }),
    readTabs: () => state.raw ?? JSON.stringify(state.ledger),
    readContinuation: sessionId => {
      lookups++
      assert.equal(sessionId, 'saved-host', 'the saved tab selects one exact host identity')
      if (state.readError) throw new Error('Synthetic private storage diagnostic')
      return state.descriptor
    },
  })
  return { read, state, entries, lookups: () => lookups }
}

test('standalone restore joins only the saved native identity and preserves words and recorded homes', async () => {
  const f = fixture(state => { state.metadata.home = path.resolve('fixture-home'); state.metadata.databaseHome = path.resolve('fixture-db') })
  const answer = await f.read(request)
  assert.equal(answer.metadata.nativeSessionId, 'saved-host')
  assert.equal(answer.metadata.threadId, 'saved-thread')
  assert.equal(answer.metadata.provider, 'codex')
  assert.equal(answer.metadata.account, 'saved-account')
  assert.equal(answer.metadata.home, f.state.metadata.home)
  assert.equal(answer.metadata.databaseHome, f.state.metadata.databaseHome)
  assert.equal(answer.entries, f.entries)
  assert.equal(f.lookups(), 1)
  assert.equal(f.state.metadata.threadId, undefined, 'lookup must not mutate stored metadata')
})

for (const [name, change, code] of [
  ['wrong computer', state => { state.metadata.computerId = 'another-computer' }, mismatch],
  ['wrong node', state => { state.metadata.nodeId = 'another-node' }, mismatch],
  ['duplicate tabs', state => { state.ledger.tabs.push({ ...state.ledger.tabs[0] }) }, mismatch],
  ['missing tab', state => { state.ledger.tabs = [] }, mismatch],
  ['another host session', state => { state.descriptor.sessionId = 'another-host' }, mismatch],
  ['another agent', state => { state.descriptor.agentId = 'another-agent' }, mismatch],
  ['another bound seat', state => { state.descriptor.roleBinding.agentId = 'another-seat' }, mismatch],
  ['tree descriptor', state => { state.descriptor.requestKeys = { threadId: nodeId, treeAnchors: [nodeId] } }, mismatch],
  ['contradictory thread', state => { state.metadata.threadId = 'another-thread' }, mismatch],
  ['contradictory provider', state => { state.metadata.provider = 'claude' }, mismatch],
  ['contradictory account', state => { state.metadata.account = null }, mismatch],
  ['no saved row', state => { state.descriptor = null }, unavailable],
  ['unreadable row', state => { state.readError = true }, unavailable],
  ['no provider thread', state => { state.descriptor.resumeThreadId = null }, unavailable],
  ['invalid provider', state => { state.descriptor.resumeThreadProvider = 'invented' }, unavailable],
  ['no recorded account', state => { delete state.descriptor.resumeAccount }, unavailable],
  ['invalid recorded account', state => { state.descriptor.resumeAccount = '' }, unavailable],
  ['no host selector', state => { state.ledger.tabs[0].sessionId = null }, unavailable],
  ['invalid JSON', state => { state.raw = '{' }, unavailable],
  ['unsupported tab version', state => { state.ledger.v = 2 }, unavailable],
  ['non-array tabs', state => { state.ledger.tabs = {} }, unavailable],
  ['oversized saved tabs', state => { state.raw = JSON.stringify(state.ledger) + ' '.repeat(65537) }, unavailable],
  ['too many tabs', state => { state.ledger.tabs.push(...Array.from({ length: 64 }, (_, i) => ({ id: 'other-' + i }))) }, unavailable],
]) test('standalone restore names ' + name + ' and keeps readable history', async () => {
  const f = fixture(change)
  const answer = await f.read(request)
  assert.equal(answer.ok, true, 'native refusal must not hide readable history as a storage failure')
  assert.equal(answer.metadata.resumeIdentityError, code)
  assert.equal(answer.metadata.threadId, null)
  assert.equal(answer.metadata.provider, null)
  assert.equal(answer.entries, f.entries)
  assert.equal(JSON.stringify(answer).includes('Synthetic private'), false)
})

test('standalone restore accepts exactly the 64-row and 64-KiB ledger bounds', async () => {
  const f = fixture(state => {
    state.ledger.tabs.push(...Array.from({ length: 63 }, (_, i) => ({ id: 'other-' + i })))
    const raw = JSON.stringify(state.ledger)
    state.raw = raw + ' '.repeat(65536 - Buffer.byteLength(raw))
  })
  const answer = await f.read(request)
  assert.equal(answer.metadata.threadId, 'saved-thread')
})

for (const [name, change] of [
  ['authoritative native binding', state => { state.metadata.nativeSessionId = 'confirmed-host' }],
  ['closed conversation', state => { state.metadata.closed = true }],
  ['non-durable speech', state => { state.durable = false }],
]) test('standalone restore leaves ' + name + ' with its existing authority', async () => {
  const f = fixture(change), answer = await f.read(request)
  assert.equal(answer.metadata, f.state.metadata)
  assert.equal(f.lookups(), 0)
})

test('tree transcript reads do not consult standalone continuation records', async () => {
  const f = fixture()
  const answer = await f.read({ ...request, nodeId: 'tree-node' })
  assert.equal(answer.metadata, f.state.metadata)
  assert.equal(f.lookups(), 0)
})

test('a complete legacy native transcript remains evidence when no continuation was saved', async () => {
  const f = fixture(state => {
    state.metadata = { ...state.metadata, threadId: 'recorded-thread', provider: 'codex', account: null }
    state.descriptor = null
  })
  const answer = await f.read(request)
  assert.equal(answer.metadata.threadId, 'recorded-thread')
  assert.equal(answer.metadata.account, null)
  assert.equal(answer.metadata.resumeIdentityError, undefined)
})

test('exact durable lookup preserves stopped rows and does not search another session', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'standalone-identity-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'agent-continuations.sqlite')
  const state = continuationModule.createContinuationState({ file })
  for (const sessionId of ['saved-host', 'other-host']) {
    const row = state.track({ sessionId, resumeThreadId: sessionId + '-thread', resumeThreadProvider: 'claude', resumeAccount: sessionId + '-account' })
    state.stop(row.key)
  }
  const before = state.list()
  const descriptor = readSavedStandaloneContinuation({ file, sessionId: 'saved-host', continuationModule })
  assert.equal(descriptor.resumeThreadId, 'saved-host-thread')
  assert.equal(descriptor.resumeAccount, 'saved-host-account')
  assert.equal(readSavedStandaloneContinuation({ file, sessionId: 'missing-host', continuationModule }), null)
  assert.deepEqual(state.list(), before, 'lookup cannot mutate, claim or schedule either saved row')
  state.close()
})

test('missing continuation file is not created by a manual restore lookup', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'standalone-no-state-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'missing.sqlite')
  assert.equal(readSavedStandaloneContinuation({ file, sessionId: 'saved-host', continuationModule }), null)
  assert.equal(existsSync(file), false)
})

test('substituted continuation link and non-file are refused before opening their destination', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'standalone-linked-state-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const destination = path.join(directory, 'destination'), file = path.join(directory, 'linked.sqlite')
  writeFileSync(destination, 'Synthetic untouched destination')
  symlinkSync(destination, file)
  const badDirectory = path.join(directory, 'directory'); mkdirSync(badDirectory)
  for (const candidate of [file, badDirectory]) {
    let opened = 0
    assert.throws(() => readSavedStandaloneContinuation({ file: candidate, sessionId: 'saved-host',
      continuationModule: { createContinuationState() { opened++; return { get: () => null, close() {} } }, keyFor: () => 'key' } }))
    assert.equal(opened, 0)
  }
})

test('invalid host selector is refused before consulting any durable storage', () => {
  assert.throws(() => readSavedStandaloneContinuation({ file: 'unused', sessionId: '', continuationModule: {} }), /Invalid saved host identity/)
})

test('host origin re-read preserves a named contradiction before account lookup', async () => {
  let lookups = 0
  const { createLegacyResumeOriginResolver } = require('../../shell/legacy-resume-origin.cjs')
  const resolve = createLegacyResumeOriginResolver({
    readTabs: () => JSON.stringify({ v: 1, tabs: [{ id: nodeId, sessionId: 'saved-host' }] }),
    readTranscript: async () => ({ ok: true, metadata: { ...request, resumeIdentityError: mismatch } }),
    accountHome: () => { lookups++; return os.tmpdir() }, defaultHome: () => { lookups++; return os.tmpdir() },
  })
  await assert.rejects(resolve({ transcript: request, sessionId: 'saved-host', threadId: 'saved-thread',
    provider: 'codex', account: null, agentId: nodeId }), { code: mismatch })
  assert.equal(lookups, 0)
})

test('durable restore distinguishes an explicitly default account from a missing account field', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'standalone-account-field-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'state.sqlite')
  const state = continuationModule.createContinuationState({ file })
  const row = state.track({ sessionId: 'saved-host', resumeThreadId: 'saved-thread',
    resumeThreadProvider: 'codex', resumeAccount: null })
  state.close()
  assert.equal(readSavedStandaloneContinuation({ file, sessionId: 'saved-host', continuationModule }).resumeAccount, null)
  const { createStateStore } = require('../../../engine/src/lib/state-store.js')
  const store = createStateStore({ file })
  const entry = store.getMemory({ namespace: 'agent.continuation.v1', key: row.key })
  delete entry.value.descriptor.resumeAccount
  store.setMemory({ namespace: 'agent.continuation.v1', key: row.key,
    expectedRevision: entry.revision, value: entry.value })
  store.close()
  assert.throws(() => readSavedStandaloneContinuation({ file, sessionId: 'saved-host', continuationModule }),
    { code: 'CONTINUATION_IDENTITY_UNAVAILABLE' })
})
