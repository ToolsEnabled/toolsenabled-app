import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createProviderModeMenu } from '../../src/provider-mode-menu.js'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const hostPath = path.join(root, 'shell/agent-host.cjs')
const { createAgentHost } = require(hostPath)
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)

const PLAN_ONLY_TEXT = 'Plan-only text must not become native mode settings.'
const AUTHORITATIVE = Object.freeze({
  model: 'engine-confirmed-model',
  effort: 'high',
  developerInstructions: 'Exact engine-confirmed resume instructions.',
})

function modeAdapter({ settings }) {
  let modes = { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }] }
  const selections = []
  const adapter = {
    modeSelectionRequiresSettings: true,
    transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
    listCollaborationModes: async () => {},
    getSessionModes: () => modes,
    selectMode: async (...args) => {
      selections.push(args)
      modes = { ...modes, currentModeId: args[1] }
      return { ...modes, appliesOn: 'next-turn' }
    },
    sendTurn: async () => ({ turnId: 'turn-1' }),
    interrupt: async () => {},
    answerApproval() {},
    updateThreadSettings: async () => {},
  }
  return { adapter, selections, settings }
}

async function fixture(t, { settings = null, unavailableReason = null } = {}) {
  const resumeRequests = []
  let starts = 0
  const f = modeAdapter({ settings })
  t.mock.method(engine, 'startCodexSession', async () => {
    starts += 1
    throw new Error('a resumed session must not fall back to a fresh start')
  })
  t.mock.method(engine, 'resumeCodexSession', async options => {
    resumeRequests.push(options)
    return {
      adapter: f.adapter,
      threadId: 'saved-native-thread',
      model: settings?.model || 'engine-confirmed-model',
      reasoningEffort: settings?.effort ?? null,
      nativeModeSettings: settings,
      nativeModeUnavailableReason: unavailableReason,
      resumed: { turns: [], turnCount: 0 },
      close() {},
    }
  })
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    profileRoot: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({
      ok: true,
      tier: 'unrestricted',
      isolated: false,
      threadOptions: { sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: PLAN_ONLY_TEXT },
      env: {},
    }),
  })
  await host.startSession({
    sessionId: 'resume-mode',
    tier: 'luna',
    effort: 'high',
    resumeThreadId: 'saved-native-thread',
    resumeThreadProvider: 'codex',
  })
  t.after(() => host.closeAll())
  return {
    host,
    starts: () => starts,
    resumeRequests,
    selections: f.selections,
    read: () => host.readSessionModes({ sessionId: 'resume-mode' }),
    select: () => host.setSessionMode({ sessionId: 'resume-mode', modeId: 'plan' }),
  }
}

test('T1631 resumed Codex without exact instructions refuses mode changes and retains the visible reason', async t => {
  const reason = 'CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE'
  const f = await fixture(t, { unavailableReason: reason })
  assert.equal(f.starts(), 0, 'resume must use the engine resume entry point')
  assert.equal(f.resumeRequests.length, 1)
  const request = f.resumeRequests[0]
  assert.equal(request.threadId, 'saved-native-thread')
  assert.equal(request.developerInstructions, undefined,
    'the host must not invent a top-level authoritative instruction string')
  assert.equal(request.threadOptions.developerInstructions, PLAN_ONLY_TEXT,
    'confinement plan text is not the native conversation instruction binding')

  const state = await f.read()
  assert.equal(state.supported, false)
  assert.equal(state.code, reason)
  await assert.rejects(f.select(), { code: reason })
  assert.equal(f.selections.length, 0, 'unsupported resumed mode must not reach the provider')

  const messages = []
  const menu = createProviderModeMenu({
    sessionId: 'resume-mode',
    bridge: { modes: request => f.host.readSessionModes(request), setMode: request => f.host.setSessionMode(request) },
  })
  t.after(() => menu.dispose())
  const context = { show: rows => assert.equal(typeof rows, 'function'), say: message => messages.push(message) }
  await menu.open(context)
  assert.match(messages.at(-1), /resumed session.*settings.*unavailable/i)
  const plan = menu.rows().find(row => row.id === 'provider-mode-plan')
  assert.equal(plan.enabled, false)
  await plan.run(context)
  assert.equal(f.selections.length, 0)
})

test('T1631 resumed Codex mode uses only the exact engine-confirmed binding when available', async t => {
  const f = await fixture(t, { settings: AUTHORITATIVE })
  const state = await f.read()
  assert.equal(state.supported, true)
  const receipt = await f.select()
  assert.equal(receipt.applied, true)
  assert.deepEqual(f.selections, [['saved-native-thread', 'plan', AUTHORITATIVE]])
})
