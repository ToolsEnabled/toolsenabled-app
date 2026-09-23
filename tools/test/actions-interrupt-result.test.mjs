import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createTurnInterrupts } from '../../src/turn-interrupts.js'
import { createPendingApprovals } from '../../src/approval-answer.js'
import { planNodeRemoval } from '../../src/tree-node-removal.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
/* SWITCH_PANEL is in this list for the reason palette-rows.test.mjs records:
   chatActionRowsFor reads it inside a conditionally spread row, so the six
   tests here that reach that spread died with "SWITCH_PANEL is not defined"
   before asserting anything, while the rest of the file went on passing. The
   real frozen object, not a stand-in, so this fixture cannot disagree with
   the product about that row's words. */
import { EFFORT_SWITCH, MODEL_PANEL, PALETTE_PANEL, REMOVE_PANEL, RESUME_PANEL, REWIND_PANEL, SWITCH_PANEL } from '../../src/fleet-tree-copy.js'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat, controlState } = await import('../../src/components.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const functions = ['nodeRemovalBlock', 'chatActionRowsFor', 'runPaletteAction', 'cancelPendingModelChoice'].map(name => declaredFunctionSource(source, name)).join('\n')
const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve() }

// Execute the complete maintained row builder, action runner and popup
// consumer. Only the DOM and IPC endpoint are fixtures; no provider starts.
function fixture(t, refusal = null, interrupt = null) {
  const node = { id: 'selected-child', sessionId: 'selected-session', status: 'running', message: 'Saved brief' }
  const calls = []
  const pending = createPendingApprovals(), cleared = []
  pending.set(node.sessionId, { approvalId: 'before-interrupt' })
  const scope = {
    PALETTE_PANEL, EFFORT_SWITCH, MODEL_PANEL, REMOVE_PANEL, RESUME_PANEL, REWIND_PANEL, SWITCH_PANEL,
    RUN_SESSION_CLEANUPS: new Map(),
    pendingModelChoices: new Map(),
    closePersonNode() { assert.fail('Interrupt must not close the session') },
    controlState, refusalCode, turnInterrupts: createTurnInterrupts(),
    sessionPendingApprovals: pending,
    clearSessionApprovals: (sessionId, approvals) => {
      for (const approval of approvals) if (pending.settle(sessionId, approval.approvalId, approval)) cleared.push(approval.approvalId)
    },
    planNodeRemoval, startDraftFlight: createSingleFlight(), nodeBranchRemovalFlight: createSingleFlight(),
    treeNodeName: value => value.id,
    window: { mcAgent: { interrupt: async request => {
      calls.push(request)
      if (interrupt) return interrupt()
      if (refusal) throw Object.assign(new Error('fixture refusal'), { code: refusal })
      return { ok: true }
    } } },
    treeStore: { getNode: id => id === node.id ? node : null, childrenOf: () => [], setNodeStatus: (id, status) => { assert.equal(id, node.id); node.status = status } },
    nodeBusy: value => value.status === 'running', nodeSessionLive: () => true,
    nodeCleanupPending: () => false, nodeSessionEnded: () => false,
    nodeReplies: new Map(), sessionTurnLog: new Map(), sessionOpenTurns: new Map([[node.sessionId, 'selected-turn']]),
    transcriptStore: { get: () => null, has: () => false }, nodeReplacementFlight: { busy: () => false },
    recoveryCoordinator: () => null, commonChatActionsFor: () => [],
    START_NEEDS_APP_TEXT: () => 'Use the installed app.', startControlOffReason: () => 'Starting is switched off.',
    isWriteEnabled: () => true, START_CONTROL_FLAG: 'agent-session',
    stopStillOwnsNode: (session, value) => value.sessionId === session,
    chatWorkspace: false, workspaceChats: new Set(),
    refreshTree: () => {}, notifyNodeStatusListeners: () => {},
  }
  const api = new Function(...Object.keys(scope), `${functions}; return { rows: chatActionRowsFor, run: runPaletteAction }`)(...Object.values(scope))
  const row = api.rows(node).find(value => value.id === 'interrupt')
  assert.equal(row.enabled, true)
  const chat = buildChat({ title: 'Selected child', history: [{ who: 'agent', text: 'Visible partial reply' }], actions: () => [row] })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  return { api, node, calls, row, chat, pending, cleared }
}

for (const [name, code, expected] of [
  ['accepted', null, PALETTE_PANEL.interruptDone],
  ['no active turn', 'AGENT_TURN_NONE', PALETTE_PANEL.interruptMissed],
  ['cleanup pending', 'AGENT_STOP_PENDING', PALETTE_PANEL.interruptFailed('AGENT_STOP_PENDING')],
  ['refused', 'MC_AGENT_UNKNOWN_SESSION', PALETTE_PANEL.interruptFailed('MC_AGENT_UNKNOWN_SESSION')],
]) {
  test(`Actions Interrupt keeps the exact ${name} receipt through the real popup consumer`, async t => {
    const f = fixture(t, code)
    f.chat.openActions()
    const button = f.chat.querySelector('.chat-actions-row')
    assert.equal(button.disabled, false)
    button.dispatch('click')
    await settle()
    assert.deepEqual(f.calls, [{ sessionId: 'selected-session' }])
    assert.equal(f.chat.querySelector('.chat-actions-out').textContent, expected)
    assert.equal(f.chat.querySelector('[data-chat-actions]').getAttribute('aria-expanded'), 'true')
    assert.equal(f.node.sessionId, 'selected-session')
    assert.deepEqual(f.cleared, code === null || code === 'AGENT_TURN_NONE' ? ['before-interrupt'] : [],
      'only confirmed cancellation retires the pending permissions')
  })
}

test('an interrupt acknowledgement cannot clear a permission raised after the request', async t => {
  let acknowledge
  const f = fixture(t, null, () => new Promise(resolve => { acknowledge = resolve }))
  const stopping = f.api.run('interrupt', f.node, { textContent: '' })
  await settle()
  f.pending.delete(f.node.sessionId)
  const next = { approvalId: 'before-interrupt' }
  f.pending.set(f.node.sessionId, next)
  acknowledge({ ok: true })
  await stopping
  assert.equal(f.pending.get(f.node.sessionId), next)
  assert.deepEqual(f.cleared, [])
})

test('the shared interrupt runner retains its structured Stop results', async t => {
  for (const [code, expected] of [[null, { ok: true }], ['AGENT_TURN_NONE', { ok: true, settled: true }], ['MC_AGENT_UNKNOWN_SESSION', { ok: false, settled: false }]]) {
    const f = fixture(t, code)
    const out = { textContent: '' }
    assert.deepEqual(await f.api.run('interrupt', f.node, out), expected)
    assert.ok(out.textContent.length > 0)
    assert.deepEqual(f.calls, [{ sessionId: 'selected-session' }])
  }
})
