/* T18 native fixture: the REAL Computers view, the REAL composer, a REAL paste.
 *
 * Adapted from computers-composer-renderer.mjs, which already establishes the
 * posture this needs: mount the real view in a real window and drive it with
 * real events, because a source pin proves a wire is attached and cannot prove
 * what comes out the other end.
 *
 * What is real here: the view, the composer, the paste event (a real
 * ClipboardEvent carrying a real File built from real PNG bytes), and the send.
 * What is simulated: the main process. window.mcAgent stands in for the
 * preload bridge and RECORDS what the renderer asked it to do -- which is the
 * measurement: did the picture the person pasted end up in the send.
 */
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

const stamp = new Date().toISOString()
const nodeId = 'fixture-manager'
const sessionId = 'fixture-session'
const computerId = 'this-computer'
const listeners = new Set()
const pasted = []
const sent = []
let view = null
let mode = 'conversation'
let savedSequence = 100
let pictureNotSent = null
let sendRefusalCode = null

const fleet = { schemaVersion: 1, domain: 'fleet', generatedAt: stamp, ok: true, reason: null, sources: [], data: { computers: [{ id: computerId, label: 'Synthetic computer', sourceKind: 'observed', observedAt: stamp, activeSessions: 1, services: [] }], graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [{ id: 'seat-one', label: 'Seat one', role: 'builder', provider: 'claude', enabled: true }], edges: [] } } }
window.fetch = async input => {
  const url = typeof input === 'string' ? input : input.url
  const value = url === '/data/fleet.json' ? fleet : url === '/data/schema/fleet.schema.json' ? schema : null
  return { ok: value !== null, status: value === null ? 404 : 200, statusText: value === null ? 'Not Found' : 'OK', json: async () => value || {} }
}
window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'synthetic' }), getBridgeTransport: async () => null }

/* THE STAND-IN MAIN PROCESS. savePasteAttachment's real job is to write the
   bytes and hand back a path it chose itself; this records the bytes so the
   test can prove the picture that arrived is the picture that was pasted, and
   returns a path of the same shape. */
window.mcAgent = {
  onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
  models: async () => ({ ok: true, models: [], provider: 'claude' }),
  sessionActivity: async () => ({ ok: true, busy: false, closing: false }),
  close: async () => ({ ok: true, closed: true }),
  start: async () => ({ ok: false }),
  pickAttachment: async () => ({ ok: true, path: 'C:/synthetic/picked.png', size: 100 }),
  pickMention: async () => ({ ok: true, path: 'src/synthetic.js' }),
  interrupt: async () => ({ ok: true }),
  setEffort: async () => ({ effort: 'high' }),
  pasteAttachment: async request => {
    savedSequence += 1
    const path = 'C:/synthetic/paste-attachments/pasted-' + savedSequence + '.png'
    pasted.push({ mime: request.mime, data: request.data, holdKey: request.holdKey ?? null, sessionId: request.sessionId ?? null, path })
    return { ok: true, path, size: atob(request.data).length }
  },
  send: async request => {
    sent.push({ text: request.text, images: (request.images || []).map(image => ({ path: image.path })), holdKey: request.holdKey ?? null })
    /* THE SHELL REFUSING THE SEND OUTRIGHT, REPLAYED AS THE PRELOAD DELIVERS IT.
       shell/agent-command-surface.cjs's 'agent:send' body checks every image
       path against the session's own allowlist and, for one that session never
       issued, calls agentIpcError BEFORE sendTurn -- so the IPC call REJECTS
       and no turn exists. shell/main.cjs rendererSafeAgentError keeps the code
       and discards the message, which is exactly the shape below. Off unless a
       test arms it, so the delivered and pictureNotSent scenarios are
       unchanged. */
    if (sendRefusalCode) throw Object.assign(new Error(sendRefusalCode), { code: sendRefusalCode })
    /* THE HOST'S OWN ANSWER WHEN THE PICTURE CANNOT GO, REPLAYED HERE.
       shell/agent-host.cjs sendTurn resolves a turn whose provider cannot carry
       the picture with `pictureNotSent` -- the provider, the file names and one
       plain sentence it already wrote for the person -- and sends the words
       alone. This stand-in returned only a turnId, so every surface's handling
       of that receipt was unmeasured, which is exactly how the sentence came to
       be written into the durable record and shown to nobody. Off unless a test
       sets it, so the existing scenario is unchanged. */
    return { turnId: 'turn-' + sent.length, ...(pictureNotSent ? { pictureNotSent } : {}) }
  },
}

const settle = async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) }
async function until(predicate) {
  const end = performance.now() + 10000
  while (!predicate()) { if (performance.now() > end) throw Error('Synthetic mount condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
  await settle()
}
const chat = () => view?.el.querySelector(mode === 'rail' ? '.rail-chat-host .chat' : '.tree-conversation[data-agent-id="' + nodeId + '"] .chat')
const composerInput = () => chat()?.querySelector('.chat-input input')
const elInfo = node => {
  if (!node) return null
  const rect = node.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
  return { tag: node.tagName, cls: node.className, visible: node.checkVisibility({ checkVisibilityCSS: true }), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hit: { tag: hit?.tagName, inside: hit === node || node.contains(hit) } }
}

window.pastePicture = {
  /* The host receipt the next send will answer with, or null for none. */
  setPictureNotSent(value) { pictureNotSent = value || null; return Boolean(pictureNotSent) },
  /* The refusal code the next send will REJECT with, or null for none. */
  setSendRefusal(code) { sendRefusalCode = typeof code === 'string' && code ? code : null; return sendRefusalCode },
  async setup(nextMode, pngBase64) {
    mode = nextMode
    pasted.length = 0
    sent.length = 0
    document.body.style.cssText = 'margin:0;height:100vh;overflow:hidden'
    document.documentElement.dataset.theme = 'white'
    location.hash = '#/computers/this-computer'
    localStorage.setItem('mc.fleet.trees.v1:' + computerId, JSON.stringify({ version: 1, computerId, trees: [{ id: 'fixture-tree', name: 'Synthetic project', createdAt: stamp, updatedAt: stamp, profileId: null }], nodes: [{ id: nodeId, treeId: 'fixture-tree', status: 'running', createdAt: stamp, updatedAt: stamp, role: 'manager', message: 'Synthetic ongoing work', statusNote: '', sessionId, parentId: null }] }))
    localStorage.setItem('mc.set.tree_style', 'boxes')
    window.__png = pngBase64
    view = computersView({ initialComputer: computerId, navigate() {} })
    document.body.append(view.el)
    await until(() => view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]'))
    view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]').focus()
    return { mode, node: elInfo(view.el.querySelector('.static-tree-node[data-agent-id="' + nodeId + '"]')) }
  },
  async ready() { await until(() => composerInput()); return { input: elInfo(composerInput()) } },
  /* THE CONVERSATION HAS TO BE IDLE BEFORE A SEND IS A SEND.
     The fixture's node is mounted mid-work, so the composer correctly QUEUES a
     message rather than sending it -- the chat shows "Send next / Send now /
     Unqueue". That queued path is real behaviour and is T20's subject, not
     T18's: the happy path this scenario exists to prove is a picture pasted
     into an idle conversation and sent. So the turn in flight is completed
     first, through the same event channel the host uses. */
  async idle() {
    for (const fn of listeners) fn({ sessionId, event: { type: 'turn_completed', turnId: 'turn-zero', status: 'success' } })
    const end = performance.now() + 5000
    while (chat()?.dataset.chatActivity === 'thinking') { if (performance.now() > end) break; await new Promise(resolve => setTimeout(resolve, 20)) }
    await settle()
    return { chatActivity: chat()?.dataset.chatActivity ?? null }
  },
  focusComposer() { const input = composerInput(); input.focus(); return elInfo(input) },
  /* THE GESTURE. A real ClipboardEvent, a real DataTransfer, a real File built
     from the same PNG bytes the Node half holds -- not a hand-shaped object
     standing in for one. This is the whole point of running in a real window. */
  async paste() {
    const input = composerInput()
    if (!input) throw Error('No composer input to paste into')
    const bytes = Uint8Array.from(atob(window.__png), c => c.charCodeAt(0))
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    const end = performance.now() + 5000
    while (!pasted.length) { if (performance.now() > end) break; await new Promise(resolve => setTimeout(resolve, 20)) }
    await settle()
    return { pastedCalls: pasted.length, defaultPrevented: event.defaultPrevented, strip: chat()?.querySelector('.chat-attachments')?.textContent ?? null }
  },
  async type(text) { const input = composerInput(); input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); await settle(); return input.value },
  async afterSend() {
    const end = performance.now() + 5000
    while (!sent.length) { if (performance.now() > end) break; await new Promise(resolve => setTimeout(resolve, 20)) }
    await settle()
    const root = chat()
    return {
      sent: sent.slice(),
      pasted: pasted.map(row => ({ mime: row.mime, path: row.path, dataLength: row.data.length, data: row.data })),
      /* Diagnostics, so a send that did not happen says why instead of just
         being an empty list. */
      diagnostic: {
        inputValue: composerInput()?.value ?? null,
        activeTag: document.activeElement?.tagName ?? null,
        activeCls: document.activeElement?.className ?? null,
        chatActivity: root?.dataset.chatActivity ?? null,
        attachmentsText: root?.querySelector('.chat-attachments')?.textContent ?? null,
        notes: [...(root?.querySelectorAll('.chat-note, .chat-log, [data-chat-note]') || [])].map(n => n.textContent).slice(0, 6),
        /* The product's own notes, as rendered: what a person actually reads
           between the bubbles. `.msg.note` is what addMsg('note', ...) makes. */
        noteMessages: [...(root?.querySelectorAll('.msg.note') || [])].map(n => (n.textContent || '').trim()).slice(0, 8),
        /* The refusal's identity as the composer recorded it, and the state the
           outbox row shows. `fail` writes the code onto its note, and an
           "unconfirmed" verdict is the thing a person SEES -- the queued row
           reads "automatic sending paused" -- so both are measurable rather
           than inferred from the sentence. */
        refusalCodes: [...(root?.querySelectorAll('.msg.note[data-refusal-code]') || [])].map(n => n.dataset.refusalCode).slice(0, 8),
        queueStates: [...(root?.querySelectorAll('.chat-queue-state') || [])].map(n => (n.textContent || '').trim()).slice(0, 8),
        buttons: [...(root?.querySelectorAll('button') || [])].map(b => ({ text: (b.textContent || '').trim().slice(0, 40), disabled: b.disabled, cls: b.className })).slice(0, 12),
        text: (root?.textContent || '').slice(0, 600),
      },
    }
  },
  dispose() { view?.destroy() },
}
