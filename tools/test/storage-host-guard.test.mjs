import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function fixture() {
  const callbacks = new Map(), calls = []
  const state = { transcript: { durable: true, pendingWrites: 0 }, capture: { durable: true, pendingWrites: 0, closing: false },
    fleet: { fleetPending: false, fleetWriteError: null }, pendingCapture: false }
  const context = {
    agentHost: null,
    nodeTranscripts: {
      getStorageStatus: () => state.transcript, assertWritable: async () => {},
      retry: async () => { calls.push('store'); return { ok: true, durable: true } },
    },
    transcriptCapture: {
      getStorageStatus: () => state.capture, hasPendingWrites: () => state.pendingCapture,
      retry: async () => { calls.push('capture'); state.capture = { durable: true, pendingWrites: 0, closing: false }; return { ok: true, durable: true } },
    },
    rendererPrefs: { snapshot: () => state.fleet, flushFleetDocuments: async () => {
      calls.push('fleet'); state.fleet = { fleetPending: false, fleetWriteError: null }; return { ok: true }
    } },
    refreshStorageRefusalNotice() {}, reportTranscriptFailure() {},
    trustedFleetProfileSender: () => true, prefsRefusal: () => ({ ok: false }),
    localDataErased: false, agentRuntimeStoppedForReset: false, prefsErasedRefusal: () => ({ ok: false }),
    transcriptRefusalCode: error => error.code, ipcMain: { handle: (name, handler) => callbacks.set(name, handler) },
  }
  const start = main.indexOf('function transcriptsCanQuit() {')
  const end = main.indexOf('\nlet transcriptCloseNoticePending', start)
  assert.ok(start >= 0 && end > start)
  vm.runInNewContext(main.slice(start, end), context)
  const ipcStart = main.indexOf("for (const operation of ['append', 'retry', 'migrate'")
  const ipcEnd = main.indexOf("ipcMain.handle('mc-transcripts:chooseArchiveDirectory'", ipcStart)
  assert.ok(ipcStart >= 0 && ipcEnd > ipcStart)
  vm.runInNewContext(main.slice(ipcStart, ipcEnd), context)
  return { state, context, calls, invoke: (operation, request) => callbacks.get('mc-transcripts:' + operation)({}, request) }
}
test('generic capture refusal blocks quit even when the transcript store still reports durable', () => {
  const f = fixture()
  f.state.capture = { durable: false, unsaved: true, pendingWrites: 0,
    error: { code: 'MC_TRANSCRIPT_STORAGE_FAILED', message: 'Accepted words remain unsaved.' } }
  assert.equal(f.context.transcriptsCanQuit(), false)
})
test('dirty or failed fleet state blocks quit until explicit persistence succeeds', async () => {
  const f = fixture()
  f.state.fleet = { fleetPending: true, fleetWriteError: 'ENOSPC' }
  assert.equal(f.context.transcriptsCanQuit(), false)
  const retry = await f.invoke('retry')
  assert.equal(retry.ok, true)
  assert.equal(f.context.transcriptsCanQuit(), true)
  assert.deepEqual(f.calls, ['store', 'capture', 'fleet'])
})
test('the actual retry handler replays capture failures before declaring all conversation storage saved', async () => {
  const f = fixture()
  f.state.capture = { durable: false, unsaved: true, pendingWrites: 0,
    error: { code: 'MC_TRANSCRIPT_STORAGE_FAILED', message: 'Accepted words remain unsaved.' } }
  const result = await f.invoke('retry')
  assert.deepEqual(f.calls, ['store', 'capture', 'fleet'])
  assert.equal(result.durable, true)
  assert.equal(f.context.transcriptsCanQuit(), true)
})
test('the main send guard refuses persistent capture and fleet failures until retry succeeds', async () => {
  const f = fixture()
  f.state.capture = { durable: false, error: { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED', message: 'Accepted input remains unsaved.' } }
  await assert.rejects(f.context.assertConversationWritable(), { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED' })
  f.state.capture = { durable: true, pendingWrites: 0 }
  f.state.fleet = { fleetPending: true, fleetWriteError: 'ENOSPC' }
  await assert.rejects(f.context.assertConversationWritable(), { code: 'MC_TRANSCRIPT_DISK_FULL' })
  await f.invoke('retry')
  await f.context.assertConversationWritable()
})
test('the actual refusal notifier logs once, replays to a newly loaded window, and clears only after storage recovers', () => {
  const f = fixture(), messages = [], logs = []
  f.context.win = { isDestroyed: () => false, webContents: { send: (channel, value) => messages.push({ channel, value }) } }
  f.context.console = { error: text => logs.push(text) }
  const first = main.indexOf('function reportTranscriptFailure(error) {')
  const last = main.indexOf('const transcriptCapture = createNodeTranscriptCapture', first)
  assert.ok(first >= 0 && last > first)
  vm.runInNewContext('let retainedTranscriptNotice = null;' + String.fromCharCode(10) + main.slice(first, last), f.context)
  f.state.fleet = { fleetPending: true, fleetWriteError: 'ENOSPC' }
  f.context.refreshStorageRefusalNotice()
  f.context.refreshStorageRefusalNotice()
  assert.equal(logs.length, 1)
  assert.equal(messages.length, 1)
  assert.match(messages[0].value.message, /disk is full/i)
  f.context.refreshStorageRefusalNotice({ replay: true })
  assert.equal(logs.length, 1, 'window replay is not another disk failure')
  assert.equal(messages.length, 2)
  f.state.fleet = { fleetPending: false, fleetWriteError: null }
  f.context.refreshStorageRefusalNotice()
  assert.equal(messages.at(-1).value.durable, true)
})
test('the main retry handler preserves an explicitly refused capture replay', async () => {
  const f = fixture()
  f.state.capture = { durable: false, unsaved: true, error: { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED', message: 'Replay still refused.' } }
  f.context.transcriptCapture.retry = async () => ({ ok: false, durable: false, error: f.state.capture.error })
  const answer = await f.invoke('retry')
  assert.equal(answer.ok, false)
  assert.equal(answer.durable, false)
  assert.equal(answer.storageError.message, 'Replay still refused.')
  assert.equal(f.context.transcriptsCanQuit(), false)
  assert.deepEqual(f.calls, ['store'])
})
test('the registered main accepted-prompt callback refuses a negative capture result', async () => {
  let accepted
  const context = { host: { onAcceptedPrompt(callback) { accepted = callback } },
    transcriptCapture: { recordAcceptedTranscriptSend: async () => ({ ok: false, code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED', message: 'Capture refused the accepted input.' }) },
    remoteDesktopSessions: null, nodeTranscripts: { waitForStorage() { assert.fail('a refused capture cannot advance to a saved boundary') } } }
  const first = main.indexOf('  host.onAcceptedPrompt(request => {')
  const last = main.indexOf('  removeAgentEventListener = host.onEvent', first)
  assert.ok(first >= 0 && last > first)
  vm.runInNewContext(main.slice(first, last), context)
  await assert.rejects(accepted({ sessionId: 'inert-session', text: 'Already accepted words.' }), { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED' })
})
test('read responses retain capture or fleet refusals for a newly mounted client', async () => {
  const f = fixture()
  f.context.nodeTranscripts.read = async () => ({ ok: true, durable: true, entries: [{ text: 'Already saved words.' }] })
  f.state.capture = { durable: false, error: { code: 'MC_TRANSCRIPT_STORAGE_FAILED', message: 'Retained capture write refused.' } }
  const capture = await f.invoke('read')
  assert.equal(capture.durable, false)
  assert.equal(capture.storageError.message, 'Retained capture write refused.')
  f.state.capture = { durable: true, pendingWrites: 0 }
  f.state.fleet = { fleetPending: true, fleetWriteError: 'ENOSPC' }
  const fleet = await f.invoke('read')
  assert.equal(fleet.durable, false)
  assert.equal(fleet.storageError.code, 'MC_TRANSCRIPT_DISK_FULL')
  assert.match(fleet.storageError.message, /disk is full/i)
  assert.equal(fleet.entries[0].text, 'Already saved words.')
})

test('quit stays blocked while a dispatched turn can still produce an accepted prompt', () => {
  const f = fixture()
  f.context.agentHost = { hasPendingTranscriptAdmissions: () => true }
  assert.equal(f.context.transcriptsCanQuit(), false)
  f.context.agentHost = { hasPendingTranscriptAdmissions: () => false }
  assert.equal(f.context.transcriptsCanQuit(), true)
})
test('shutdown reports a held capture failure before waiting for its retry-only drain', async t => {
  const held = Promise.withResolvers(), calls = []
  let result = 'pending'
  const context = {
    transcriptCapture: { sealForShutdown: () => held.promise,
      shutdown: async () => { calls.push('capture'); throw Object.assign(new Error('Accepted words are unsaved.'), { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED' }) } },
    nodeRecovery: { stop: async () => {} }, agentHost: { closeAll: async () => {} },
    agentSessions: new Map(), recordSessionEnd() {}, usageRecorder: null,
    rendererPrefs: { flushFleetDocuments: async () => { assert.fail('cannot persist beyond unsaved capture') } },
    nodeTranscripts: { shutdown: async () => { assert.fail('cannot erase unsaved transcript') } },
    nodePrivacyCleanup: { prepare() { assert.fail('cannot start privacy cleanup') }, complete() { assert.fail('cannot complete privacy cleanup') } },
  }
  const first = main.indexOf('async function closeAgentSessionsForQuit() {')
  const last = main.indexOf('function transcriptsCanQuit() {', first)
  assert.ok(first >= 0 && last > first)
  vm.runInNewContext(main.slice(first, last), context)
  const closing = context.closeAgentSessionsForQuit().then(() => { result = 'saved' }, error => { result = error.code })
  t.after(async () => { held.resolve(false); await closing })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(result, 'MC_TRANSCRIPT_CAPTURE_UNSAVED')
  assert.deepEqual(calls, ['capture'])
})
