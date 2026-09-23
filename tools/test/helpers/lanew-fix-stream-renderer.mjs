// Lane W fix (B): the actual Computers view, its actual tree and chat, with a
// transcript long enough to scroll. Only the DOM host, engine bridge and fetch
// are substitutes; no provider is started. Derived from the reviewed
// lanew-w3-renderer.mjs with a seeded history and scroll observations.
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/source-sans-3'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '../../../src/glow.css'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/hand-controls.css'
import '../../../src/guided-step.css'
import '../../../src/phone-canvas.css'
import '../../../src/phone-ledger.css'
import '../../../src/accessibility-controls.css'
import '../../../src/morphs.css'
import '../../../src/chat-content.css'
import '../../../src/chat-session-changes.css'
import '../../../src/chat-presentation.css'
import '../../../src/chat-response.css'
import '../../../src/chat-activity.css'
import '../../../src/diff-editor.css'
import '../../../src/app-navigation.css'
import '../../../src/sidebar-pages.css'
import '../../../src/first-use-guidance.css'
import '../../../src/readability.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
import '../../../src/home-chat.css'
import '../../../src/home-chat-layout.css'
import { computersView } from '../../../src/views/computers.js'
import schema from '../../../public/data/schema/fleet.schema.json'

const stamp = new Date().toISOString(), nodeId = 'fixture-manager', sessionId = 'fixture-session', computerId = 'this-computer'
const listeners = new Set(), calls = []
let view, mode = 'conversation', busy = false, turnSeq = 0, liveTurn = null
const fleet = { schemaVersion: 1, domain: 'fleet', generatedAt: stamp, ok: true, reason: null, sources: [], data: { computers: [{ id: computerId, label: 'Synthetic computer', sourceKind: 'observed', observedAt: stamp, activeSessions: 1, services: [] }], graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [{ id: 'seat-one', label: 'Seat one', role: 'builder', provider: 'claude', enabled: true }], edges: [] } } }
window.fetch = async input => {
  const url = typeof input === 'string' ? input : input.url
  const value = url === '/data/fleet.json' ? fleet : url === '/data/schema/fleet.schema.json' ? schema : null
  return { ok: value !== null, status: value === null ? 404 : 200, statusText: value === null ? 'Not Found' : 'OK', json: async () => value || {} }
}
window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'synthetic' }), getBridgeTransport: async () => null }
window.mcAgent = {
  onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
  models: async () => ({ ok: true, models: [], provider: 'codex' }),
  sessionActivity: async () => ({ ok: true, busy, closing: false }),
  close: async () => ({ ok: true, closed: true }),
  start: async () => ({ ok: false }),
  interrupt: async () => { calls.push({ name: 'interrupt' }); return { ok: true } },
  send: async request => { calls.push({ name: 'send', text: request?.text ?? null }); turnSeq += 1; return { turnId: 'synthetic-turn-' + turnSeq } },
  setEffort: async () => ({ effort: 'high' }),
}
const settle = async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) }
async function until(predicate) {
  const end = performance.now() + 10000
  while (!predicate()) { if (performance.now() > end) throw Error('Synthetic mount condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
  await settle()
}
const chat = () => view?.el.querySelector(mode === 'rail' ? '.rail-chat-host .chat' : '.tree-conversation[data-agent-id="' + nodeId + '"] .chat')
const logEl = () => chat()?.querySelector('.chat-log')
const emit = event => { for (const fn of listeners) fn({ sessionId, event }) }
const elInfo = n => {
  if (!n) return null
  const r = n.getBoundingClientRect()
  return { tag: n.tagName, cls: n.className, hidden: n.hidden === true, text: (n.textContent || '').slice(0, 60), visible: n.checkVisibility({ checkVisibilityCSS: true }), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
}
window.fix = {
  async setup(nextMode) {
    mode = nextMode; busy = false; turnSeq = 0; liveTurn = null; calls.length = 0
    localStorage.clear()
    document.body.style.cssText = 'margin:0;height:100vh;overflow:hidden'
    document.documentElement.dataset.theme = 'white'
    location.hash = '#/computers/this-computer'
    localStorage.setItem('mc.fleet.trees.v1:' + computerId, JSON.stringify({ version: 1, computerId, trees: [{ id: 'fixture-tree', name: 'Synthetic project', createdAt: stamp, updatedAt: stamp, profileId: null }], nodes: [{ id: nodeId, treeId: 'fixture-tree', status: 'finished', createdAt: stamp, updatedAt: stamp, role: 'manager', message: 'Synthetic earlier work', statusNote: '', sessionId, parentId: null }] }))
    localStorage.setItem('mc.set.tree_style', 'boxes')
    view = computersView({ initialComputer: computerId, navigate() {} })
    document.body.append(view.el)
    await until(() => view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]'))
    view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]').focus()
    return { listeners: listeners.size }
  },
  async ready() { await until(() => chat()); return this.read() },
  // A transcript long enough that the log actually scrolls: complete turns only.
  async seed(count) {
    for (let i = 0; i < count; i++) {
      const id = 'seeded-turn-' + i
      emit({ type: 'assistant_text_delta', turnId: id, text: `Seeded paragraph ${i}. This sentence exists to give the transcript real height so the reading position can be measured against a genuine overflow rather than a one-line log.` })
      emit({ type: 'turn_completed', turnId: id, status: 'completed' })
    }
    await until(() => (logEl()?.scrollHeight || 0) > (logEl()?.clientHeight || 0) + 200)
    return this.read()
  },
  // The entry path a returning reader meets: the transcript and the live turn
  // arrive together, with no settling in between.
  async seedAndStream(count) {
    for (let i = 0; i < count; i++) {
      const id = 'seeded-turn-' + i
      emit({ type: 'assistant_text_delta', turnId: id, text: `Seeded paragraph ${i}. This sentence exists to give the transcript real height so the reading position can be measured against a genuine overflow rather than a one-line log.` })
      emit({ type: 'turn_completed', turnId: id, status: 'completed' })
    }
    busy = true
    liveTurn = 'live-turn'
    emit({ type: 'thinking', turnId: liveTurn, itemId: 'summary', status: 'inProgress', text: 'I am checking the synthetic work. Pending fragment' })
    for (let i = 0; i < 2; i++) emit({ type: 'tool_call', turnId: liveTurn, itemId: 'tool-' + i, toolCallId: 'tool-' + i, tool: 'commandExecution', payload: { command: 'synthetic command ' + i } })
    emit({ type: 'assistant_text_delta', turnId: liveTurn, text: 'An unfinished reply without its ending' })
    await until(() => chat()?.dataset.chatActivity && chat().dataset.chatActivity !== 'idle')
    return this.read()
  },
  // Sample thinking on arrival, before readable reply text folds the group.
  async startStream() {
    busy = true
    liveTurn = 'live-turn'
    emit({ type: 'thinking', turnId: liveTurn, itemId: 'summary', status: 'inProgress', text: 'I am checking the synthetic work. Pending fragment' })
    for (let i = 0; i < 2; i++) emit({ type: 'tool_call', turnId: liveTurn, itemId: 'tool-' + i, toolCallId: 'tool-' + i, tool: 'commandExecution', payload: { command: 'synthetic command ' + i } })
    await until(() => chat()?.dataset.chatActivity && chat().dataset.chatActivity !== 'idle')
    return this.read()
  },
  async beginReply() {
    emit({ type: 'assistant_text_delta', turnId: liveTurn, text: 'An unfinished reply without its ending' })
    return this.read()
  },
  /* More live content gives the scroll test enough height to measure growth.
     Fragments are displayed immediately too; beginReply measures that decided
     contract separately from the longer text used for the scroll test. */
  async grow(times) {
    const before = logEl()?.scrollHeight || 0
    for (let i = 0; i < times; i++) emit({ type: 'assistant_text_delta', turnId: liveTurn, text: ` A further complete sentence number ${i} arrives and keeps the live turn getting taller.` })
    await settle(); await new Promise(resolve => setTimeout(resolve, 120)); await settle()
    const state = await this.read()
    state.grewBy = (logEl()?.scrollHeight || 0) - before
    return state
  },
  logRect() { const l = logEl(); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } },
  async read() {
    await settle()
    const root = chat(), log = logEl()
    const thinkingBodies = [...(root?.querySelectorAll('.chat-thinking-body') || [])]
    const live = root?.querySelector('.msg.them:last-of-type')
    const inView = node => { if (!node || !log) return false; const r = node.getBoundingClientRect(), l = log.getBoundingClientRect(); return r.bottom > l.top && r.top < l.bottom }
    return {
      mode, activity: root?.dataset.chatActivity || null,
      log: log ? { scrollTop: Math.round(log.scrollTop), scrollHeight: Math.round(log.scrollHeight), clientHeight: Math.round(log.clientHeight), atBottom: log.scrollHeight - log.scrollTop - log.clientHeight <= 2 } : null,
      newBelow: elInfo([...(root?.querySelectorAll('button') || [])].find(b => /new below/i.test(b.textContent))),
      thinking: thinkingBodies.map(n => ({ text: n.textContent.slice(0, 60), visible: n.checkVisibility({ checkVisibilityCSS: true }), inView: inView(n) })),
      liveTurnInView: inView(live),
      reply: elInfo(live?.querySelector('.chat-msg-text')),
      calls: calls.slice(),
    }
  },
  dispose() { view?.destroy() },
}
