// T736: synthetic values through each maintained consumer, never a provider.
// The tree's full dispatcher + buildChat path is in chat-whole-output-currentness.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { readFileSync } from 'node:fs'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import * as events from '../../src/agent-session-events.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'

const world = installDomStandIn()
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const cells = new Map([['mc.write.agent-session', 'enabled']])
globalThis.localStorage = {
  getItem: key => cells.get(key) ?? null,
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: key => cells.delete(key),
}
after(async () => {
  await tick(60)
  world.restore()
  if (storageBefore) Object.defineProperty(globalThis, 'localStorage', storageBefore)
  else delete globalThis.localStorage
})
const { buildChat } = await import('../../src/components.js')
const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
const { mountDesktopSessionChat } = await import('../../src/desktop-sessions.js')
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const memoryStorage = () => {
  const data = new Map()
  return { read: key => structuredClone(data.get(key) ?? null), write: (key, value) => { data.set(key, structuredClone(value)); return true } }
}
function extracted(file, accepts, scope) {
  const source = readFileSync(new URL('../../src/' + file, import.meta.url), 'utf8')
  const found = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    const chosen = accepts(node, source)
    if (chosen) found.push(source.slice(chosen.start, chosen.end))
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  assert.equal(found.length, 1, 'one maintained event consumer must be selected')
  return new Function('scope', 'with (scope) { return (' + found[0] + ') }')(scope)
}
const answerRows = root => root.querySelectorAll('.them').map(row => {
  const body = row.querySelector('.chat-msg-text'), paragraphs = body.querySelectorAll('.md-p')
  return paragraphs.length ? paragraphs.map(p => p.textContent).join('\n\n') : body.textContent.trim()
})
const plain = text => text.replace(/\s+/g, ' ').trim()

async function home() {
  const liveSessions = new Map()
  const scope = { ...events, destroyed: false, liveSessions,
    state: { sessions: { runs: [{ sessionId: 's' }] } },
    sessionTextReader: events.createSessionTextReader(), askForLedger() {}, paintLiveSoon() {} }
  const consume = extracted('views/home.js', node =>
    node.type === 'VariableDeclarator' && node.id?.name === 'onAgentPacket' ? node.init : null, scope)
  return { sessionId: 's', consume, text: () => liveSessions.get('s')?.text ?? '',
    finish: () => {}, dispose: () => { scope.destroyed = true; scope.sessionTextReader.clear() } }
}
async function agentPage() {
  let answer = ''
  const scope = { ...events, chatSessionId: 's', chatTurnText: '', chatFail: null,
    chatReply: text => { answer = text }, chatTextReader: events.createSessionTextReader(),
    rememberRuleCall() {}, takeRuleCall() {}, chat: {}, paintChatThinking: () => false, settleChatThinking() {} }
  const consume = extracted('views/agent.js', (node, source) =>
    node.type === 'CallExpression' && source.slice(node.callee.start, node.callee.end) === 'agentBridge.onEvent' ? node.arguments[0] : null, scope)
  return { sessionId: 's', consume, text: () => answer || scope.chatTurnText,
    finish: () => {}, dispose: () => { scope.chatSessionId = null; scope.chatTextReader.clear() } }
}
async function coordinator(t) {
  let listener, serial = 0
  const treeStore = createFleetTreeStore({ computerId: 'fixture', storage: memoryStorage(), makeId: () => 'node-' + (++serial) })
  const added = treeStore.addNode({ role: 'controller', message: 'Synthetic reader task' })
  assert.equal(added.ok, true)
  const nodeId = added.node.id
  assert.equal(treeStore.attachSession(nodeId, 's').ok, true)
  treeStore.setNodeStatus(nodeId, 'running')
  const transcriptStore = createTranscriptStore({ computerId: 'fixture', storage: memoryStorage() })
  const controller = createAccountRecoveryCoordinator({
    bridge: { onEvent: callback => { listener = callback; return () => { listener = null } } },
    sessionNodeIds: new Map([['s', nodeId]]),
  })
  controller.register('fixture', { treeStore, transcriptStore })
  t.after(() => controller.destroy())
  return { sessionId: 's', consume: packet => listener?.(packet),
    text: () => transcriptStore.get(nodeId)?.lines.at(-1)?.text ?? '',
    finish: () => {}, afterCompletion: true, dispose: () => controller.destroy() }
}
async function standalone(t) {
  let listener, control
  const root = document.createElement('div'); document.body.appendChild(root)
  const calls = []
  const bridge = {
    availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: callback => { listener = callback; return () => { listener = null } },
    start: async request => ({ sessionId: request.sessionId }),
    send: async request => { calls.push(request); return { turnId: 'turn' } },
    close: async request => ({ sessionId: request.sessionId, closed: true }),
    interrupt: async () => ({ ok: true }),
  }
  const dispose = mountAgentSessionSurface(root, { live: true, agentId: 'reader-fixture', bridge,
    chatComposer: true, publishSession: false, onController: value => { control = value } })
  t.after(() => { dispose(); root.remove() })
  await tick()
  assert.ok(control, 'standalone mount publishes controller: ' + root.textContent)
  const sent = await control.send('Synthetic owner message')
  assert.equal(sent.ok, true)
  return { sessionId: sent.sessionId, consume: packet => listener?.(packet),
    text: () => answerRows(root).at(-1) ?? '', finish: () => assert.equal(calls.length, 1),
    dispose }
}
async function desktop(t) {
  let listener, entries = []
  const root = document.createElement('div'); document.body.appendChild(root)
  const chat = mountDesktopSessionChat({ host: root,
    row: { sessionId: 's', agentId: 'reader', name: 'Reader', openable: true, transcript: true, busy: true },
    mayWrite: false, buildChat,
    bridge: { transcript: async () => ({ ok: true, sessionId: 's', bound: true, entries, before: null }) },
    subscribe: callback => { listener = callback; return () => { listener = null } },
    scheduleFrame: callback => setTimeout(callback, 0), cancelFrame: clearTimeout,
  })
  t.after(() => { chat.dispose(); root.remove() })
  await tick()
  return { sessionId: 's', consume: packet => listener?.(packet), text: () => answerRows(root).at(-1) ?? '',
    finish: expected => { entries = [{ id: 'reply', who: 'agent', text: expected, turnId: 'turn', at: 100 }] },
    dispose: () => chat.dispose() }
}
for (const [name, factory] of Object.entries({ home, agentPage, coordinator, standalone, desktop })) {
  for (const streamed of [false, true]) test(name + ' admits ' + (streamed ? 'stream/final overlap and distinct repeats' : 'whole-only final') + ' through its production consumer', async t => {
    const f = await factory(t)
    const emit = (type, text, itemId, extra = {}) => f.consume({ sessionId: f.sessionId, event: { type, turnId: 'turn', text, itemId, ...extra } })
    if (streamed) emit('assistant_text_delta', 'Before.', 'one')
    emit('assistant_text', 'Before. ready.', 'one')
    emit('assistant_text', 'Before. ready.', 'one')
    emit('tool_call', '', undefined, { toolCallId: 'read', tool: 'fixture.read' })
    emit('tool_result', 'Synthetic tool output.', undefined, { toolCallId: 'read', tool: 'fixture.read', status: 'ok' })
    emit('assistant_text', 'Same.', 'two')
    emit('assistant_text', 'Same.', 'three')
    emit('assistant_text', 'Invisible delivery.', 'hidden', { treeDelivery: true })
    const expected = 'Before. ready.\n\nSame.\n\nSame.'
    await tick(60)
    if (!f.afterCompletion) assert.equal(plain(f.text()), plain(expected), 'the full text must be observable before completion')
    f.finish(expected)
    emit('turn_completed', '', undefined, { status: 'completed' })
    await tick(60)
    assert.equal(plain(f.text()), plain(expected))
    f.dispose()
    const retired = f.text() // disposal may intentionally remove its own DOM
    emit('assistant_text', 'Retired output.', 'late')
    assert.equal(f.text(), retired, 'retired consumers cannot publish late output')
  })
}
