import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const ENGINE = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(ENGINE)
const { createNativeResumeOriginStore } = require('../../shell/native-resume-origin-store.cjs')
const { createLedgerContinuation } = require(path.join(canonicalRootForTests(), 'src/lib/agent-ledger-continuation.js'))
const { createContinuationState } = require(path.join(canonicalRootForTests(), 'src/lib/agent-continuation-state.js'))

async function mounted(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rewind-origin-'))
  const home = path.join(directory, 'home'), origins = path.join(directory, 'origins')
  mkdirSync(home)
  const { document, restore } = installDomStandIn()
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  t.after(() => { if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage })
  const root = document.createElement('div'); document.body.appendChild(root)
  const sends = [], resumes = [], updates = [], packets = []
  let control, nativeEvent, durable
  const adapter = {
    sendTurn: async request => { sends.push(request); return { turnId: 'turn-' + sends.length } },
    forkThread: async () => ({ threadId: 'candidate-fork' }),
    interrupt: async () => {}, answerApproval() {},
  }
  t.mock.method(engine, 'startCodexSession', async request => {
    nativeEvent = request.onEvent
    return { adapter, threadId: 'original-thread', close() {} }
  })
  t.mock.method(engine, 'resumeCodexSession', async request => {
    resumes.push(request); nativeEvent = request.onEvent
    return { adapter, threadId: request.threadId, resumed: { turns: [], turnCount: 0 }, close() {} }
  })
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: directory,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(directory).root,
    resumeOriginDirectory: origins, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false,
      threadOptions: {}, env: { CODEX_HOME: home } }),
    ledgerContinuationLoader: () => ({ createLedgerContinuation(options) {
      const runner = createLedgerContinuation({ ...options, readTasks: () => [],
        readSettings: () => ({ values: { 'agent.persistent_continuation': true } }),
        stateFactory: () => (durable = createContinuationState({ file: ':memory:' })),
      })
      return { ...runner, update(session, changes) { updates.push(changes); return runner.update(session, changes) } }
    } }),
  })
  const listeners = new Set()
  host.onEvent(packet => { packets.push(packet); for (const fn of listeners) fn(packet) })
  const bridge = { availability: async () => ({ ok: true }),
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    start: async request => {
      const result = await host.startSession(request)
      host.rememberContinuation(result.sessionId, { tier: 'astra' })
      return result
    },
    send: request => host.sendTurn(request), close: request => host.closeSession(request),
    interrupt: request => host.interrupt(request),
  }
  const release = mountAgentSessionSurface(root, { live: true, bridge, chatComposer: true,
    onController: value => { control = value }, getStartOptions: () => ({ tier: 'astra' }) })
  t.after(async () => { release(); await host.closeAll(); restore(); rmSync(directory, { recursive: true, force: true }) })
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await control.send('Remember the original conversation.')).ok, true)
  const id = control.snapshot().sessionId
  nativeEvent({ type: 'turn_completed', turnId: 'turn-1', status: 'completed' })
  return { host, control, id, sends, resumes, updates, packets,
    durable: () => durable, origin: () => createNativeResumeOriginStore({ directory: origins }).get(id),
    finish: () => nativeEvent({ type: 'turn_completed', turnId: 'turn-' + sends.length, status: 'completed' }) }
}

test('failed fork-origin persistence keeps mounted Send and Stop/Send on the original native conversation', async t => {
  const f = await mounted(t)
  const oldOrigin = f.origin()
  const sync = t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('synthetic flush failure'), { code: 'EIO' }) })
  let refusal
  try { await f.host.rewindSession({ sessionId: f.id, turnId: 'turn-1' }) } catch (error) { refusal = error }
  sync.mock.restore()
  assert.equal(f.host.sessionTranscriptMetadata(f.id).threadId, 'original-thread', 'failed storage moved the live host')
  assert.equal(f.control.snapshot().threadId, 'original-thread', 'renderer identity must stay on the original')
  assert.deepEqual(f.origin(), oldOrigin)
  assert.equal(f.durable().list()[0].descriptor.resumeThreadId, 'original-thread')
  assert.equal(f.packets.filter(packet => packet.event.type === 'session_thread_changed').length, 0)
  assert.equal(f.updates.filter(change => change.resumeThreadId === 'candidate-fork').length, 0)
  assert.equal(refusal?.code, 'AGENT_REWIND_ORIGIN_STORAGE_FAILED')
  assert.equal(refusal?.message, 'Rewind could not save the fork’s original sign-in home. This conversation is still on its previous thread.')
  assert.equal(f.host.sessionActivity(f.id).busy, false)
  assert.equal((await f.control.send('Continue after the refused rewind.')).ok, true)
  assert.equal(f.sends.at(-1).threadId, 'original-thread', 'the abandoned fork must never receive a send')
  f.finish()
  assert.equal((await f.control.terminate()).ok, true)
  assert.equal((await f.control.send('Recall after Stop.')).ok, true)
  assert.equal(f.resumes.at(-1).threadId, 'original-thread')
  assert.equal(f.sends.at(-1).threadId, 'original-thread')
})

test('a successful fork publishes host, continuation and renderer identity only after origin persistence', async t => {
  const f = await mounted(t)
  const flush = fs.fsyncSync
  let checked = false
  t.mock.method(fs, 'fsyncSync', fd => {
    checked = true
    assert.equal(f.host.sessionTranscriptMetadata(f.id).threadId, 'original-thread')
    assert.equal(f.control.snapshot().threadId, 'original-thread')
    assert.equal(f.durable().list()[0].descriptor.resumeThreadId, 'original-thread')
    return flush(fd)
  })
  assert.equal((await f.host.rewindSession({ sessionId: f.id, turnId: 'turn-1' })).threadId, 'candidate-fork')
  assert.equal(checked, true, 'the real origin store flushed the candidate')
  assert.equal(f.origin().threadId, 'candidate-fork')
  assert.equal(f.control.snapshot().threadId, 'candidate-fork')
  assert.equal(f.durable().list()[0].descriptor.resumeThreadId, 'candidate-fork')
  assert.equal((await f.control.send('Continue the fork.')).ok, true)
  assert.equal(f.sends.at(-1).threadId, 'candidate-fork')
})
