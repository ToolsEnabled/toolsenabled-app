// Lane W T20: the actual Computers view, its actual tree, chat and QUEUE, so
// Send next / Send now / Unqueue are the product's own doors driven by native
// input. Only the DOM host, engine bridge and fetch are substitutes; no
// provider is started. Derived from the reviewed lanew-fix-stream-renderer.mjs.
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
let view, mode = 'conversation', busy = false, liveTurn = null, turnSeq = 0
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
  pickAttachment: async () => ({ ok: true, path: 'C:/synthetic/pasted.png', size: 75 }),
  /* A real engine ENDS the turn when it is interrupted, and Send now calls
     runStop({ waitForIdle: true }) and then waits for that idle before it
     delivers. A fixture whose interrupt only flips a flag never goes idle, so
     the delivery never fires and the product looks broken when it is not --
     that is measured, and it is why this emits the completion. */
  interrupt: async () => {
    calls.push({ name: 'interrupt', at: calls.length })
    if (liveTurn) emit({ type: 'turn_completed', turnId: liveTurn, status: 'interrupted' })
    busy = false
    return { ok: true }
  },
  // Every delivery this product makes is recorded here, in order, with its words.
  send: async request => {
    turnSeq += 1
    calls.push({ name: 'send', at: calls.length, text: request?.text ?? request?.message ?? null, attachments: (request?.attachments || []).map(a => (a && a.path) || String(a)) })
    liveTurn = 'turn-' + turnSeq
    busy = true
    return { turnId: liveTurn }
  },
  setEffort: async () => ({ effort: 'high' }),
}
const settle = async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) }
async function until(predicate, label) {
  const end = performance.now() + 10000
  while (!predicate()) { if (performance.now() > end) throw Error('T20 condition timed out: ' + label); await new Promise(r => setTimeout(r, 20)) }
  await settle()
}
const chat = () => view?.el.querySelector(mode === 'rail' ? '.rail-chat-host .chat' : '.tree-conversation[data-agent-id="' + nodeId + '"] .chat')
const emit = event => { for (const fn of listeners) fn({ sessionId, event }) }
const elInfo = n => {
  if (!n) return null
  const r = n.getBoundingClientRect()
  return { tag: n.tagName, cls: String(n.className || ''), disabled: n.disabled === true, text: (n.textContent || '').slice(0, 60), visible: n.checkVisibility({ checkVisibilityCSS: true }), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
}
window.t20 = {
  async setup(nextMode) {
    mode = nextMode; busy = false; liveTurn = null; turnSeq = 0; calls.length = 0
    localStorage.clear()
    document.body.style.cssText = 'margin:0;height:100vh;overflow:hidden'
    document.documentElement.dataset.theme = 'white'
    location.hash = '#/computers/this-computer'
    localStorage.setItem('mc.fleet.trees.v1:' + computerId, JSON.stringify({ version: 1, computerId, trees: [{ id: 'fixture-tree', name: 'Synthetic project', createdAt: stamp, updatedAt: stamp, profileId: null }], nodes: [{ id: nodeId, treeId: 'fixture-tree', status: 'finished', createdAt: stamp, updatedAt: stamp, role: 'manager', message: 'Synthetic earlier work', statusNote: '', sessionId, parentId: null }] }))
    localStorage.setItem('mc.set.tree_style', 'boxes')
    view = computersView({ initialComputer: computerId, navigate() {} })
    document.body.append(view.el)
    await until(() => view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]'), 'tree node')
    view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]').focus()
    return { ok: true }
  },
  async ready() { await until(() => chat(), 'chat mounted'); return this.read() },
  // A turn the person can see running, so a typed Enter has something to queue behind.
  async startTurn() {
    busy = true
    liveTurn = 'running-turn'
    emit({ type: 'thinking', turnId: liveTurn, itemId: 'summary', status: 'inProgress', text: 'I am working on the first request.' })
    emit({ type: 'assistant_text_delta', turnId: liveTurn, text: 'Working on it without finishing this sentence yet' })
    await until(() => (chat()?.dataset.chatActivity || 'idle') !== 'idle', 'busy')
    return this.read()
  },
  // The running turn finishes, which is the boundary the ordinary drain uses.
  async finishTurn() {
    if (!liveTurn) return this.read()
    emit({ type: 'assistant_text_delta', turnId: liveTurn, text: ' and now it ends.' })
    emit({ type: 'turn_completed', turnId: liveTurn, status: 'completed' })
    busy = false
    await settle(); await new Promise(r => setTimeout(r, 400)); await settle()
    return this.read()
  },
  focusComposer() { const i = chat().querySelector('.chat-input input'); i.focus(); return elInfo(i) },
  setComposer(text) { const i = chat().querySelector('.chat-input input'); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return elInfo(i) },
  async read() {
    await settle()
    const root = chat(), input = root?.querySelector('.chat-input input')
    const rows = [...(root?.querySelectorAll('.chat-queue-row') || [])].map(row => ({
      text: row.querySelector('.chat-queue-text')?.textContent || '',
      next: elInfo(row.querySelector('.chat-queue-next')),
      now: elInfo([...row.querySelectorAll('button')].find(b => /send now/i.test(b.textContent))),
      unqueue: elInfo([...row.querySelectorAll('button')].find(b => /unqueue/i.test(b.textContent))),
    }))
    return {
      mode, activity: root?.dataset.chatActivity || null, value: input?.value ?? null,
      strip: elInfo(root?.querySelector('.chat-queue-strip')),
      rows,
      attachmentChips: [...(root?.querySelectorAll('.chat-attachment-chip') || [])].map(c => c.textContent),
      meBubbles: [...(root?.querySelectorAll('.msg.me') || [])].map(n => (n.textContent || '').slice(0, 80)),
      /* 400, not 120: the unqueue note carries a sentence of explanation AND
         the person's own words after it, and a 120-char window cut the words
         off mid-phrase -- which read as the product losing them when it had
         not. The observation must not be narrower than the thing observed. */
      notes: [...(root?.querySelectorAll('.msg.note') || [])].map(n => (n.textContent || '').slice(0, 400)),
      sends: calls.filter(c => c.name === 'send').map(c => ({ text: c.text, attachments: c.attachments })),
      interrupts: calls.filter(c => c.name === 'interrupt').length,
      calls: calls.map(c => c.name),
    }
  },
  dispose() { view?.destroy() },
}
