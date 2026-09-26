import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function fixture(boundary) {
  let callback
  const packets = []
  const session = { owner: { isDestroyed: () => false, send: (_channel, packet) => packets.push(packet) } }
  const context = {
    host: { onEvent(fn) { callback = fn } }, removeAgentEventListener: null,
    agentSessions: new Map([['synthetic-session', session]]),
    bindSessionChangePaths: packet => packet, WORKSPACE_ROOT: 'synthetic-workspace', path: {},
    mainLagMonitor: { note: (_name, fn) => fn() },
    getAgentCommandSurface: () => ({ forwardSessionEvent: () => false }),
    AGENT_EVENT_CHANNEL: 'synthetic-event', transcriptCapture: { packet: () => boundary },
    noteAgentTurnUsage() {}, noteAgentTurnCompleted() {}, ownedByThisWindow: () => false,
  }
  const start = main.indexOf('  removeAgentEventListener = host.onEvent(')
  const end = main.indexOf("  /* THE CHILD'S OWN EXIT", start)
  assert.ok(start >= 0 && end > start, 'load the actual registered main event callback')
  vm.runInNewContext(main.slice(start, end), context)
  return { emit: packet => callback(packet), packets, context }
}
test('the actual main event callback forwards only after transcript capture accepts the event', async () => {
  const boundary = Promise.withResolvers()
  const f = fixture(boundary.promise)
  const packet = { sessionId: 'synthetic-session', event: { type: 'assistant_text_delta', text: 'Captured synthetic output.' } }
  const delivery = f.emit(packet)
  assert.equal(f.packets.length, 0, 'the renderer cannot display a later event that is still behind disk backpressure')
  boundary.resolve()
  await delivery
  assert.equal(f.packets.length, 1)
  assert.equal(f.packets[0], packet)
})
test('a rejected capture promise is returned to the producer without forwarding uncaptured output', async () => {
  const boundary = Promise.withResolvers()
  const f = fixture(boundary.promise)
  const delivery = Promise.resolve(f.emit({ sessionId: 'synthetic-session', event: { type: 'assistant_text_delta', text: 'Uncaptured output.' } }))
  const rejection = assert.rejects(delivery, { code: 'MC_TRANSCRIPT_STORAGE_FAILED' })
  boundary.reject(Object.assign(new Error('Synthetic disk refusal'), { code: 'MC_TRANSCRIPT_STORAGE_FAILED' }))
  await rejection
  assert.equal(f.packets.length, 0)
})

test('a final provider packet delivered during orderly close is captured before session routing is released', async () => {
  const f = fixture(Promise.resolve()), retained = []
  let sealed = false
  Object.assign(f.context, {
    agentHost: { closeAll: async () => {
      await f.emit({ sessionId: 'synthetic-session', event: { type: 'assistant_text_delta', text: 'Final words from the closing provider.' } })
    } },
    nodeRecovery: { stop: async () => {} }, usageRecorder: null,
    recordSessionEnd() {},
    transcriptCapture: {
      packet: async packet => {
        if (sealed) throw Object.assign(new Error('Capture is sealed'), { code: 'MC_TRANSCRIPT_CAPTURE_CLOSING' })
        retained.push(packet.event.text)
      },
      sealForShutdown: () => { sealed = true; return Promise.resolve(true) },
      shutdown: async () => { sealed = true },
    },
    rendererPrefs: { flushFleetDocuments: async () => ({ ok: true }) },
    nodeTranscripts: { shutdown: async () => {} },
    nodePrivacyCleanup: { prepare() {}, complete() {} },
  })
  const start = main.indexOf('async function closeAgentSessionsForQuit() {')
  const end = main.indexOf('function transcriptsCanQuit() {', start)
  vm.runInNewContext(main.slice(start, end), f.context)
  await f.context.closeAgentSessionsForQuit()
  assert.deepEqual(retained, ['Final words from the closing provider.'])
  assert.equal(f.packets.length, 1)
  assert.equal(f.context.agentSessions.size, 0)
  assert.equal(sealed, true)
})
