/* T830: one read of host presence precedes the saved-session models probes.
 * All sessions and provider transports here are inert fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createAgentHost } from '../../shell/agent-host.cjs'
const require = createRequire(import.meta.url)
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const ENGINE = path.resolve(import.meta.dirname, 'fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
const recorder = require(ENGINE)
const owner = {}
const principal = { kind: 'window', owner, mayWrite: true, label: 'fixture window' }
const fail = code => { throw Object.assign(new Error(code), { code }) }
function fixture() {
  const calls = []
  const sessions = new Map([
    ['live', { owner, state: 'ready' }],
    ['host-missing', { owner, state: 'ready' }],
    ['foreign', { owner: {}, state: 'ready' }],
    ['ended', { owner, state: 'ended' }],
  ])
  const host = { heldSessionIds({ sessionIds }) { calls.push(sessionIds); return ['live', 'foreign', 'not-requested'] } }
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([key, type]) => [key,
    type === 'function' ? () => null : type === 'number' ? 128 : type === 'string' ? os.tmpdir() : {}]))
  Object.assign(deps, {
    agentSessions: sessions, currentAgentHost: () => host, getAgentHost: () => host,
    agentIpcError: fail, rendererSafeAgentError: error => error,
    agentPayload(value, keys) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('MC_AGENT_INVALID_PAYLOAD')
      return value
    },
    boundedAgentString(value, _key, max) {
      if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) fail('MC_AGENT_INVALID_PAYLOAD')
      return value
    },
    AGENT_EFFORT_VALUES: [],
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, MAX_SESSION_ID_LENGTH: 128,
  })
  return { surface: createAgentCommandSurface(deps), calls, host, sessions }
}
test('presence returns only requested live sessions owned by this window, with one host read', async () => {
  const f = fixture()
  const result = await f.surface.run('agent:session-presence', { sessionIds: ['stale', 'live', 'live', 'host-missing', 'foreign', 'ended'] }, principal)
  assert.deepEqual(result, { ok: true, sessionIds: ['live'] })
  assert.deepEqual(f.calls, [['live', 'host-missing']])
  assert.equal(f.sessions.size, 4, 'a presence read never removes a saved or live session')
})
test('presence rejects malformed or over-fleet-limit input before consulting the host', async () => {
  const f = fixture()
  for (const sessionIds of [null, 'live', [''], ['x'.repeat(129)], Array(4097).fill('live')]) {
    await assert.rejects(f.surface.run('agent:session-presence', { sessionIds }, principal), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  }
  assert.equal(f.calls.length, 0)
})
test('presence refuses a remote principal and an unavailable host without claiming absence', async () => {
  const f = fixture()
  await assert.rejects(f.surface.run('agent:session-presence', { sessionIds: ['live'] }, { ...principal, kind: 'relay' }), { code: 'MC_AGENT_PRINCIPAL_INVALID' })
  delete f.host.heldSessionIds
  await assert.rejects(f.surface.run('agent:session-presence', { sessionIds: ['live'] }, principal), { code: 'AGENT_SESSION_PRESENCE_UNAVAILABLE' })
  assert.equal(f.calls.length, 0)
})
test('presence rechecks owner lifetime when an asynchronous host read finishes', async () => {
  const f = fixture()
  let release
  f.host.heldSessionIds = () => new Promise(resolve => { release = resolve })
  const pending = f.surface.run('agent:session-presence', { sessionIds: ['live'] }, principal)
  await new Promise(resolve => setImmediate(resolve))
  f.sessions.set('live', { owner: {}, state: 'ready' })
  release(['live'])
  assert.deepEqual(await pending, { ok: true, sessionIds: [] })
})
test('real host presence distinguishes ready, absent and closed sessions without a provider model probe', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't830-presence-'))
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {}, servers: [] })
  let host, begin, release
  const began = new Promise(resolve => { begin = resolve })
  const admission = new Promise(resolve => { release = resolve })
  try {
    t.mock.method(recorder, 'startCodexSession', async () => {
      begin()
      await admission
      return ({
      threadId: 'presence-thread',
      adapter: { transport: { child: { exitCode: null, signalCode: null } }, sendTurn: async () => { throw new Error('No provider send expected') }, interrupt: async () => {}, answerApproval() {} },
      close() {},
    }) })
    host = createAgentHost({
      enginePath: ENGINE, defaultCwd: root, startProviderProbe: () => 'codex',
      providerCommandResolver: () => path.join(root, 'never-launched'), freeMemory: () => 64 * 1024 ** 3,
    })
    const starting = host.startSession({ sessionId: 'live' })
    await began
    assert.deepEqual(await host.heldSessionIds({ sessionIds: ['old', 'live'] }), ['live'],
      'a starting host-held session must not become a permanent absence stamp')
    release()
    await starting
    assert.deepEqual(await host.heldSessionIds({ sessionIds: ['old', 'live', 'live'] }), ['live'])
    await host.closeSession({ sessionId: 'live' })
    assert.deepEqual(await host.heldSessionIds({ sessionIds: ['live'] }), [])
  } finally {
    release()
    await host?.closeAll()
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
    console.log('RETAINED_T830_FIXTURE ' + root)
  }
})

test('the native preload routes one batch through the trusted main handler and command surface', async () => {
  const f = fixture(), handlers = new Map(), exposed = new Map()
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('mc-agent:session-presence'")
  assert.ok(start >= 0, 'the native handler must be registered')
  const end = main.indexOf('\n})', start) + 3
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedAgentSender: event => { if (event.sender !== owner) fail('UNTRUSTED_FIXTURE_WINDOW') },
    windowPrincipal: () => principal, getAgentCommandSurface: () => f.surface,
  })
  const invokes = []
  const ipcRenderer = {
    on() {}, send() {}, sendSync() { return {} }, removeListener() {},
    invoke(name, payload) {
      invokes.push({ name, payload })
      return handlers.get(name)({ sender: owner }, payload)
    },
  }
  vm.runInNewContext(readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }, ipcRenderer } },
    process: { platform: process.platform }, window: { addEventListener() {} },
  })
  const answer = await exposed.get('mcAgent').sessionPresence({ sessionIds: ['live', 'stale'] })
  assert.deepEqual(answer, { ok: true, sessionIds: ['live'] })
  assert.deepEqual(invokes.map(row => row.name), ['mc-agent:session-presence'])
  assert.deepEqual(f.calls, [['live']])
  assert.throws(() => handlers.get('mc-agent:session-presence')({ sender: {} }, { sessionIds: ['live'] }), { code: 'UNTRUSTED_FIXTURE_WINDOW' })
  assert.equal(f.calls.length, 1, 'an untrusted sender cannot reach the session reader')
})
