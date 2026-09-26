import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { retryWorld, settle } from './helpers/t844-retry-world.mjs'

const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const row = (chat, label) => [...chat.querySelectorAll('.chat-actions-row')]
  .find(item => item.children[0]?.textContent === label)
const status = chat => chat.querySelector('.chat-actions-out')?.textContent || ''

// Mount computersView and its real chips/actions. Only DOM, IPC transport and
// provider process are inert. The command surface and host mode methods are
// production modules; the adapter reports its own state and acknowledgement.
async function fixture(t) {
  const f = await retryWorld(t)
  const directory = mkdtempSync(path.join(os.tmpdir(), 't1026-controls-'))
  let modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'plan', name: 'Plan' }] }
  let release
  const changes = [], sends = [], commands = []
  const adapter = {
    transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
    getSessionModes: () => modes,
    async selectMode(threadId, modeId) {
      changes.push({ threadId, modeId })
      const confirmed = await new Promise(resolve => { release = resolve })
      if (confirmed) modes = { ...modes, currentModeId: modeId }
      return { ...modes, appliesOn: 'next-turn' }
    },
    async sendTurn(request) { sends.push(request); throw new Error('No provider send belongs to a mode change') },
    async interrupt() {}, answerApproval() {},
  }
  t.mock.method(engine, 'startCodexSession', async () => ({ threadId: 'mode-fixture-thread', adapter, close() {} }))
  const host = createAgentHost({
    enginePath, defaultCwd: directory, profileRoot: directory, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  t.after(async () => { release?.(false); await host.closeAll(); console.log('RETAINED_T1026_FIXTURE ' + directory) })
  await host.startSession({ sessionId: f.sessionId, tier: 'luna' })
  const owner = {}, principal = { kind: 'window', owner, mayWrite: true, label: 'fixture window' }
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([key, type]) => [key,
    type === 'function' ? () => null : type === 'number' ? 128 : type === 'string' ? directory : {}]))
  Object.assign(deps, {
    agentSessions: new Map([[f.sessionId, { owner, state: 'ready' }]]),
    currentAgentHost: () => host, getAgentHost: () => host,
    agentIpcError: fail, rendererSafeAgentError: error => error,
    agentPayload(value, keys) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('MC_AGENT_INVALID_PAYLOAD')
      return value
    },
    boundedAgentString(value, _key, maximum) {
      if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) fail('MC_AGENT_INVALID_PAYLOAD')
      return value
    },
    parseAgentSessionCommand: value => ({ sessionId: value.sessionId }),
    AGENT_EFFORT_VALUES: [], dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    MAX_SESSION_ID_LENGTH: 128,
  })
  const surface = createAgentCommandSurface(deps)
  const run = async (command, payload) => {
    commands.push({ command, payload: structuredClone(payload) })
    try { return await surface.run(command, payload, principal) }
    catch (error) {
      // Electron invoke only retains Error.message; exercise that wire shape.
      throw new Error('Error invoking remote method: Error: ' + (error.code || error.message))
    }
  }
  f.world.bridge.modes = request => run('agent:modes', request)
  f.world.bridge.setMode = request => run('agent:mode', request)
  let tier = 'standard'
  const tierWrites = []
  window.mcSetup = {
    tierState: async () => ({ ok: true, available: true, configured: true, tier, tiers: ['guided', 'standard', 'unrestricted'] }),
    chooseTier: async next => { tierWrites.push(next); tier = next; return { ok: true, tier } },
  }
  const chat = await f.openChat()
  chat.importDraft({ text: '  Keep this draft and picture.  ', attachments: [{ path: 'inert-picture.png', size: 23 }] })
  const draft = chat.exportDraft(), input = chat.querySelector('.chat-input textarea'), page = f.view.el
  assert.ok(input, 'the actual mounted composer must exist before identity comparisons')
  const beforeHash = location.hash
  return {
    ...f, chat, host, changes, sends, commands, tierWrites,
    finish: confirmed => release(confirmed),
    assertComposer() {
      assert.equal(f.view.el, page)
      assert.equal(location.hash, beforeHash)
      const current = chat.querySelector('.chat-input textarea')
      assert.ok(current, 'the mounted composer must still exist')
      assert.equal(current, input)
      assert.deepEqual(chat.exportDraft(), draft)
      assert.deepEqual(sends, [])
    },
    async openMode() {
      const chip = chat.querySelector('[data-chat-chip="mode"]')
      assert.ok(chip, 'the actual Computers chat exposes the provider-mode chip')
      chip.dispatch('click')
      await settle(8)
      assert.ok(row(chat, 'Plan'), 'the actual action obtains advertised modes through the command surface')
    },
  }
}

test('T1026 Computers mode chip applies only the authoritative host acknowledgement and keeps the composer', async t => {
  const f = await fixture(t)
  await f.openMode()
  assert.equal(f.host.readSessionModes({ sessionId: f.sessionId }).currentModeId, 'ask')
  row(f.chat, 'Plan').dispatch('click')
  await settle(4)
  assert.deepEqual(f.changes, [{ threadId: 'mode-fixture-thread', modeId: 'plan' }])
  assert.equal(f.host.readSessionModes({ sessionId: f.sessionId }).currentModeId, 'ask', 'intent is not effective state')
  assert.match(status(f.chat), /Waiting for provider mode confirmation/)
  f.assertComposer()
  f.finish(true)
  await settle(8)
  assert.equal(f.host.readSessionModes({ sessionId: f.sessionId }).currentModeId, 'plan')
  assert.match(status(f.chat), /Plan.*next turn/)
  assert.deepEqual(f.commands.filter(item => item.command === 'agent:mode'), [
    { command: 'agent:mode', payload: { sessionId: f.sessionId, modeId: 'plan' } },
  ])
  f.assertComposer()
  assert.deepEqual(f.tierWrites, [], 'provider mode must not write the permission tier')
  await f.openMode()
  assert.match(status(f.chat), /Plan.*next turn/, 'reopen reads the host-confirmed state')
})

test('T1026 Computers mode refusal remains visible and blocks another selection until a fresh host read', async t => {
  const f = await fixture(t)
  await f.openMode()
  row(f.chat, 'Plan').dispatch('click')
  await settle(4)
  f.finish(false)
  await settle(8)
  const refusal = status(f.chat)
  assert.match(refusal, /Refresh provider modes/)
  assert.doesNotMatch(refusal, /Error invoking|AGENT_|mode applied/i)
  assert.equal(row(f.chat, 'Plan').disabled, true)
  assert.equal(f.host.readSessionModes({ sessionId: f.sessionId }).currentModeId, 'ask')
  row(f.chat, 'Plan').dispatch('click')
  await settle(4)
  assert.equal(f.changes.length, 1, 'a stale disabled row cannot dispatch again')
  assert.match(status(f.chat), /Refresh provider modes/)
  assert.ok(f.chat.querySelector('.chat-actions-pop').textContent.includes(refusal), 'the retained refusal remains in its state row even when a disabled-row hint is announced')
  f.assertComposer()
  row(f.chat, 'Refresh provider modes').dispatch('click')
  await settle(8)
  assert.match(status(f.chat), /Current provider mode: Ask/)
  assert.equal(row(f.chat, 'Plan').disabled, false)
  assert.equal(f.changes.length, 1, 'refresh only reads authority')
  assert.deepEqual(f.tierWrites, [])
})

test('T1026 Computers permission chip opens inline and changes saved tier without selecting provider mode', async t => {
  const f = await fixture(t)
  const chip = f.chat.querySelector('[data-chat-chip="tier"]')
  assert.ok(chip, 'the actual Computers chat exposes permission settings')
  chip.dispatch('click')
  await settle(8)
  assert.match(status(f.chat), /future starts and resumes/)
  assert.ok(row(f.chat, 'Guided'))
  f.assertComposer()
  row(f.chat, 'Guided').dispatch('click')
  await settle(8)
  assert.deepEqual(f.tierWrites, ['guided'])
  assert.match(status(f.chat), /Saved permission level: Guided/)
  assert.deepEqual(f.commands, [], 'permission tier never uses the provider-mode command surface')
  assert.deepEqual(f.changes, [])
  f.assertComposer()
})
