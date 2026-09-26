/* A CODEX TURN THAT HAS GONE QUIET IS SAID TO BE QUIET, BESIDE STOP.
 *
 * Codex 0.156 runs a model's script in its code-mode host. With more than
 * about 130 tool calls in flight in one script that host can stop dispatching
 * and never answer: no event, no timeout, no CPU (reproduced
 * offline). A controller circle sat in that state for hours and every
 * surface showed it only as busy. Stop recovers it (turn/interrupt completes
 * the turn as interrupted in milliseconds).
 *
 * What must hold, driven through the real host with a fake Codex adapter and
 * an injected clock (shell/agent-host.cjs noProgressWatch):
 *   - a running Codex turn with no engine event for 10 minutes, and no tool
 *     call open, is reported once: sessionActivity().noProgress (and so
 *     app_context) and one no_progress packet; under 10 minutes it is not;
 *   - nothing is stopped: no interrupt reaches the adapter and the turn stays
 *     busy;
 *   - the next engine event takes the report back, and a later quiet stretch
 *     is reported again;
 *   - an open tool call (a long command or MCP call), an approval question the
 *     person has not answered yet, and a turn that keeps streaming are never
 *     reported; an idle session and a Claude turn are not;
 *   - Stop on a quiet turn ends it and the report with it;
 * and the windows say it in plain words in the working row, beside the Stop
 * control, and take back only that line.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { sessionNoProgressEvent } from '../../src/agent-session-events.js'
import { noProgressLine } from '../../src/fleet-tree-copy.js'
import { WORKING_CANCEL } from '../../src/chat-copy.js'
import { findingsInText } from '../check-plain-language.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { fleetFetch, installWorld, seedTreeNode, settle as settleTree } from './lib/tree-command-real-mount.mjs'
import { register } from 'node:module'

register('./css-loader.mjs', import.meta.url)

const require = createRequire(import.meta.url)
const ENGINE = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const CLAUDE_ENGINE = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js')
const engine = require(ENGINE)
const claudeEngine = require(CLAUDE_ENGINE)
const MINUTE = 60_000
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-no-progress-'))
  let clock = 1_000_000
  let turn = 0
  let onEvent = () => {}
  const starts = []
  const polls = new Set()
  const interruptions = []
  const started = async options => {
    onEvent = options.onEvent
    starts.push(options.onEvent)
    return { threadId: 'thread-1', close() {}, adapter: {
      sendTurn: async () => ({ turnId: `turn-${++turn}` }),
      interrupt: async () => {
        interruptions.push(`turn-${turn}`)
        queueMicrotask(() => onEvent({ type: 'turn_completed', turnId: `turn-${turn}`, status: 'interrupted' }))
      },
      answerApproval() {},
    } }
  }
  t.mock.method(engine, 'startCodexSession', started)
  if (typeof claudeEngine.startClaudeSession === 'function') t.mock.method(claudeEngine, 'startClaudeSession', started)
  const host = createAgentHost({
    enginePath: ENGINE,
    defaultCwd: root,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(root).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    noProgressWatch: { now: () => clock, set: fn => { polls.add(fn); return { unref() {} } }, clear: () => polls.clear() },
  })
  const packets = []
  host.onEvent(packet => { if (packet.event?.type === 'no_progress') packets.push({ ...packet.event }) })
  t.after(async () => {
    await host.closeAll()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    host, packets, interruptions, polls,
    emit: event => onEvent({ turnId: `turn-${turn}`, ...event }),
    emitTo: (index, event) => starts[index]({ turnId: `turn-${turn}`, ...event }),
    activity: (sessionId = 'circle') => host.sessionActivity(sessionId),
    /* Move the clock and run the host's own poll, as its 30-second interval does. */
    async wait(ms) {
      clock += ms
      for (const poll of polls) poll()
      await tick(); await tick()
    },
    async run(tier = 'luna', sessionId = 'circle') {
      await host.startSession({ sessionId, tier })
      await host.sendTurn({ sessionId, text: 'read the plan' })
    },
  }
}

test('a Codex turn with no engine event for ten minutes is reported once, and nothing is stopped', async t => {
  const f = fixture(t)
  await f.run()
  await f.wait(10 * MINUTE - 1000)
  assert.equal(f.activity().busy, true)
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false, 'under ten minutes is not reported')
  assert.deepEqual(f.packets, [])

  await f.wait(1000)
  assert.deepEqual(f.activity().noProgress, { quietForMs: 10 * MINUTE })
  assert.deepEqual(f.packets, [{ type: 'no_progress', active: true, quietForMs: 10 * MINUTE }])

  await f.wait(5 * MINUTE)
  assert.equal(f.packets.length, 1, 'the windows are told once, not every poll')
  assert.deepEqual(f.activity().noProgress, { quietForMs: 15 * MINUTE }, 'app_context reads the current quiet time')
  assert.deepEqual(f.interruptions, [], 'nothing is stopped for the person')
  assert.equal(f.activity().busy, true, 'the turn is still running')
})

test('the next engine event takes the report back, and a later quiet stretch is reported again', async t => {
  const f = fixture(t)
  await f.run()
  await f.wait(11 * MINUTE)
  assert.equal(f.packets.length, 1)

  f.emit({ type: 'assistant_text_delta', text: 'still here' })
  await tick()
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false)
  assert.deepEqual(f.packets.at(-1), { type: 'no_progress', active: false })

  await f.wait(9 * MINUTE)
  assert.equal(f.packets.length, 2, 'the quiet time restarted at that event')
  await f.wait(1 * MINUTE)
  assert.deepEqual(f.packets.at(-1), { type: 'no_progress', active: true, quietForMs: 10 * MINUTE })
})

test('an open tool call is never reported, however long it runs; its result restarts the quiet time', async t => {
  const f = fixture(t)
  await f.run()
  f.emit({ type: 'tool_call', itemId: 'call-1', toolCallId: 'call-1', tool: 'mcpToolCall', payload: { server: 'toolsenabled', tool: 'host_exec' } })
  await f.wait(14 * MINUTE)
  await f.wait(14 * MINUTE)
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false, 'a long command or MCP call is work, not a stall')
  assert.deepEqual(f.packets, [])

  f.emit({ type: 'tool_result', itemId: 'call-1', toolCallId: 'call-1', tool: 'mcpToolCall', payload: { status: 'completed' } })
  await f.wait(9 * MINUTE)
  assert.deepEqual(f.packets, [])
  await f.wait(1 * MINUTE)
  assert.deepEqual(f.packets, [{ type: 'no_progress', active: true, quietForMs: 10 * MINUTE }])
})

test('a turn waiting on the person to answer an approval question is never called stuck', async t => {
  const f = fixture(t)
  await f.run()
  f.emit({ type: 'approval_request', itemId: 'cmd-1', approval: { approvalId: 'codex:approval:fixture', kind: 'commandExecution', details: {}, availableDecisions: ['accept', 'decline'] } })
  await f.wait(30 * MINUTE)
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false, 'the agent is waiting on the person, not stuck')
  assert.deepEqual(f.packets, [])

  await f.host.answerApproval({ sessionId: 'circle', approvalId: 'codex:approval:fixture', decision: 'accept' })
  await f.wait(9 * MINUTE)
  assert.deepEqual(f.packets, [], 'the answer restarted the quiet time')
  await f.wait(1 * MINUTE)
  assert.deepEqual(f.packets, [{ type: 'no_progress', active: true, quietForMs: 10 * MINUTE }])
})

test('a turn that keeps streaming is never reported, and neither is an idle session or a finished turn', async t => {
  const f = fixture(t)
  await f.run()
  for (let minute = 0; minute < 30; minute += 5) {
    f.emit({ type: 'thinking', itemId: 'reasoning-1', text: 'Comparing two plans.', status: 'inProgress' })
    await f.wait(5 * MINUTE)
  }
  assert.deepEqual(f.packets, [])
  f.emit({ type: 'turn_completed', status: 'completed' })
  await tick()
  await f.wait(60 * MINUTE)
  assert.equal(f.activity().busy, false)
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false)
  assert.deepEqual(f.packets, [])
})

test('only Codex turns are reported: a quiet Claude turn is left alone', async t => {
  const f = fixture(t)
  await f.run('luna', 'codex-circle')
  await f.run('claude-sonnet', 'circle')
  f.emitTo(1, { type: 'thinking', itemId: 'reasoning-1', text: 'Reading.', status: 'inProgress' })
  await f.wait(60 * MINUTE)
  assert.ok(f.activity('codex-circle').noProgress, 'the same poll reports the quiet Codex turn beside it')
  assert.equal(f.activity().busy, true)
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false, 'the Claude turn is not reported')
  assert.equal(f.packets.length, 1)
})

test('Stop on a quiet turn ends the turn and the report with it', async t => {
  const f = fixture(t)
  await f.run()
  await f.wait(12 * MINUTE)
  assert.equal(f.packets.length, 1)
  await f.host.interrupt({ sessionId: 'circle' })
  await tick(); await tick()
  assert.deepEqual(f.interruptions, ['turn-1'], 'Stop reaches the adapter')
  assert.equal(f.activity().busy, false, 'the interrupted turn is over')
  assert.equal(Object.hasOwn(f.activity(), 'noProgress'), false)
  assert.deepEqual(f.packets.at(-1), { type: 'no_progress', active: false })
  await f.wait(30 * MINUTE)
  assert.equal(f.packets.length, 2, 'an idle session is not reported')
})

test('the reader admits only the exact packet, and the words are plain', () => {
  const packet = event => ({ sessionId: 's-1', event })
  assert.deepEqual(sessionNoProgressEvent(packet({ type: 'no_progress', active: true, quietForMs: 600000 }), 's-1'), { active: true, quietForMs: 600000 })
  assert.deepEqual(sessionNoProgressEvent(packet({ type: 'no_progress', active: false }), 's-1'), { active: false, quietForMs: null })
  for (const event of [{ type: 'no_progress', active: true }, { type: 'no_progress', active: 'yes', quietForMs: 1 },
    { type: 'no_progress', active: true, quietForMs: -1 }, { type: 'usage', active: true, quietForMs: 1 }]) {
    assert.equal(sessionNoProgressEvent(packet(event), 's-1'), null, JSON.stringify(event))
  }
  assert.equal(sessionNoProgressEvent(packet({ type: 'no_progress', active: false }), 's-2'), null, 'another session')
  assert.equal(noProgressLine(600000), 'No progress for 10 minutes; the agent may be stuck. Stopping this reply recovers it.')
  assert.equal(noProgressLine(754000), 'No progress for 12 minutes; the agent may be stuck. Stopping this reply recovers it.')
  assert.deepEqual(findingsInText(noProgressLine(600000)), [], 'the plain-language rules find nothing')
})

/* THE WINDOW: the + chat's working row, beside its Stop control, through the
   real mount the person opens (the harness of
   tools/test/halt-standalone-agent-real-interrupt.test.mjs). */
async function standaloneChat(t) {
  const { mountStandaloneAgent } = await import('../../src/tree-standalone-agent.js')
  const { resetLiveSessionForTest } = await import('../../src/agent-session-registry.js')
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
  const { document, restore } = installDomStandIn()
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0)
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const calls = [], listeners = new Set()
  const bridge = {
    ownerContext: async () => ({ version: 1, ownerId: 'quiet-fixture-owner', currentEpoch: 'quiet-fixture-epoch', kind: 'local' }),
    onOwnerContextChanged: () => () => {},
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start: async value => { calls.push(['start', value]); return { sessionId: value.sessionId } },
    send: async value => { calls.push(['send', value]); return { turnId: 'turn-1' } },
    interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
    close: async value => { calls.push(['close', value]); return { closed: true } },
  }
  const transcript = { async bind() { return { ok: true } }, async release() { return { ok: true, released: true } } }
  const host = document.createElement('div'); document.body.appendChild(host)
  const adapter = mountStandaloneAgent(host, { id: 'agent-1', name: 'agent-1', live: true, bridge, transcript, start: { tier: 'luna' } })
  t.after(async () => {
    adapter.dispose()
    await settle()
    resetLiveSessionForTest()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    restore()
  })
  const chat = () => host.querySelector('[data-chat-panel]')
  const input = chat().querySelector('.chat-input textarea')
  input.value = 'Read the plan and fan out.'
  input.dispatch('input')
  chat().querySelector('.chat-send').click()
  await settle()
  const sessionId = calls.find(([kind]) => kind === 'send')?.[1]?.sessionId
  assert.ok(sessionId, 'the turn reached the bridge')
  return {
    before: chat().querySelector('.working-step [data-chat-working-step]')?.textContent || '',
    settle,
    emit: async event => { for (const listener of listeners) listener({ sessionId, event }); await settle() },
    step: () => chat().querySelector('.working-step [data-chat-working-step]')?.textContent || '',
    row: () => chat().querySelector('.working-step'),
  }
}

test('the working row says it beside the Stop control, and takes back only its own line', async t => {
  const panel = await standaloneChat(t)
  await panel.emit({ type: 'no_progress', active: true, quietForMs: 11 * MINUTE })
  assert.equal(panel.row().hidden, false)
  assert.equal(panel.step(), noProgressLine(11 * MINUTE))
  assert.equal(panel.row().querySelector('button')?.textContent, WORKING_CANCEL, 'the Stop control is right there')

  await panel.emit({ type: 'no_progress', active: false })
  assert.equal(panel.step(), panel.before, 'progress takes the line back to what the row said before')
  assert.notEqual(panel.before, noProgressLine(11 * MINUTE))

  await panel.emit({ type: 'no_progress', active: true, quietForMs: 10 * MINUTE })
  await panel.emit({ type: 'tool_call', turnId: 'turn-1', toolCallId: 'call-9', tool: 'commandExecution', payload: { command: 'npm test' } })
  const newer = panel.step()
  assert.notEqual(newer, noProgressLine(10 * MINUTE), 'a real step replaces it')
  await panel.emit({ type: 'no_progress', active: false })
  assert.equal(panel.step(), newer, 'and taking the report back leaves the newer step alone')
})

/* THE CIRCLE: the tree conversation's working row, through the real tree
   view (the harness of tools/test/chat-final-after-tools.test.mjs). */
test("a circle's working row says it too, and takes it back on the next engine event", async t => {
  const computerId = 'quiet-computer', nodeId = 'quiet-node', sessionId = 'quiet-session'
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  let view, surface, host
  t.after(() => { surface?.dispose(); view?.destroy(); host?.remove(); delete window.mcTranscripts; world.restore() })
  world.storage.setItem('mc.write.agent-session', 'enabled')
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'running' })
  const listeners = new Set()
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.sessionActivity = async () => ({ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 })
  window.mcTranscripts = {
    list: async () => ({ ok: true, records: [{ computerId, nodeId }] }),
    read: async () => ({ ok: true, entries: [], metadata: { computerId, nodeId }, before: null }),
    append: async () => ({ ok: true }), bind: async () => ({ ok: true }), onError: () => () => {},
  }
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: computerId, navigate() {}, chatWorkspace: true })
  document.body.appendChild(view.el)
  await view.chatWorkspace.ready
  await settleTree()
  host = document.createElement('div')
  document.body.appendChild(host)
  surface = view.chatWorkspace.mount(host, { nodeId })
  await settleTree()
  const emit = async event => {
    for (const listener of listeners) await listener({ sessionId, event })
    await settleTree(4)
  }
  const step = () => surface.root.querySelector('.working-step [data-chat-working-step]')?.textContent || ''
  const row = () => surface.root.querySelector('.working-step')

  await emit({ type: 'tool_call', turnId: 'turn-1', itemId: 'plan', toolCallId: 'plan', tool: 'commandExecution', payload: { command: 'cat plan.tsv' } })
  await emit({ type: 'tool_result', turnId: 'turn-1', itemId: 'plan', toolCallId: 'plan', tool: 'commandExecution', payload: { status: 'completed', exitCode: 0 } })
  const before = step()
  assert.ok(before, 'the busy circle shows a working step')

  await emit({ type: 'no_progress', active: true, quietForMs: 10 * MINUTE })
  assert.equal(row().hidden, false)
  assert.equal(step(), noProgressLine(10 * MINUTE), 'the circle says it has gone quiet')
  assert.ok(row().querySelector('button'), 'beside its Stop control')

  await emit({ type: 'no_progress', active: false })
  assert.notEqual(step(), noProgressLine(10 * MINUTE), 'progress takes the line back')

  await emit({ type: 'no_progress', active: true, quietForMs: 12 * MINUTE })
  await emit({ type: 'tool_call', turnId: 'turn-1', itemId: 'next', toolCallId: 'next', tool: 'commandExecution', payload: { command: 'npm test' } })
  const newer = step()
  assert.notEqual(newer, noProgressLine(12 * MINUTE), 'a real step replaces it')
  await emit({ type: 'no_progress', active: false })
  assert.equal(step(), newer, 'and taking the report back leaves the newer step alone')
})
