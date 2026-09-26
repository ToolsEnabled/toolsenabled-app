/* B18 (found by hand on the 1.0.48 candidate, 2026-09-26): after a restart, a send in a tree agent's
 * open rail chat went to the saved session id from the previous run. The refusal started the
 * automatic resume, by design, and the agent answered on a new session, and the answer was saved.
 * But the open rail still routed speech by the dead id, so the reply never reached that chat until
 * the rail was rebuilt (deselect, reselect).
 *
 * WHY: the rail captures its session id once, at mount, and every rail speech gate (the delta that
 * opens and pushes the rail bubble, scheduleRailStream, the turn closes) compares against it. The
 * only rebind after a resume is the full rebuild at the end of resumeNodeSessionUnguarded, and that
 * rebuild waits for a blur while the rail composer has focus -- which it always has right after
 * Enter. So the rail stayed on the dead id for the whole reply.
 *
 * This runs the actual rail mount (tree-rail-chat-harness), the actual buildChat, the actual
 * deferRailRebuildWhileTyping, the actual tail of resumeNodeSessionUnguarded (from
 * `const appliedEffort` to its final return), the actual scheduleRailStream and the actual rail
 * branch of the delta handler, in one vm context. Stubs stand in only for the maps and the store
 * the tail writes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { buildChat } from '../../src/components.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createDrafts, createRailView, functions, functionSource, viewSource } from './helpers/tree-rail-chat-harness.mjs'

const resumeBody = functions.get('resumeNodeSessionUnguarded')?.body.body
assert.ok(resumeBody, 'resumeNodeSessionUnguarded is gone')
const tailFrom = resumeBody.findIndex(statement => viewSource.slice(statement.start, statement.end).startsWith('const appliedEffort'))
assert.ok(tailFrom > 0, 'the resume tail marker (const appliedEffort) moved')
const tailSource = viewSource.slice(resumeBody[tailFrom].start, resumeBody.at(-1).end)

/* The delta handler's rail branch: the one statement that opens the rail bubble on a delta. */
function railDeltaBranch() {
  const found = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'IfStatement') {
      const text = viewSource.slice(node.start, node.end)
      if (text.startsWith('if (railChat && railChat.sessionId === sessionId) {') && text.includes('openStream')) found.push(text)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  functions.forEach(visit)
  assert.equal(new Set(found).size, 1, 'the rail branch of the delta handler moved')
  return found[0]
}

function resumeWithOpenRail(t, { focusComposer, railOnAnotherNode = false }) {
  const dom = installDomStandIn()
  const view = createRailView({ buildChat, drafts: createDrafts() })
  t.after(() => { view.destroy(); dom.restore() })
  const node = { id: 'b18-controller', sessionId: 'dead-session-from-1.0.47', role: 'controller', treeId: 'tree' }
  const shown = railOnAnotherNode ? { id: 'b18-worker', sessionId: 'worker-session', role: 'worker', treeId: 'tree' } : node
  const chat = view.mount(shown)
  const input = chat.querySelector('.chat-input textarea')
  if (focusComposer) input.focus()
  else dom.document.activeElement = null
  const nodes = new Map([[node.id, { ...node }]])
  const rebuilds = []
  const store = {
    attachSession: (id, sessionId) => { nodes.get(id).sessionId = sessionId },
    setNodeStatus: (id, status) => { nodes.get(id).status = status },
    getNode: id => nodes.get(id),
    setNodeLaunchPreferences() {},
  }
  Object.assign(view.context, {
    document: dom.document,
    node, oldSessionId: node.sessionId,
    result: { ok: true, sessionId: 'resumed-session', threadId: 'thread-1', account: null },
    requestedTier: null, chosenEffort: null, engineResumed: true, deferSeed: true, seedLines: [], savedLines: [],
    profileId: null, out: null, destroyed: false, graph: null, store, treeStore: store,
    sessionNodeIds: new Map([[node.sessionId, node.id]]), sessionTranscripts: new Map(), sessionTurnLog: new Map(),
    sessionUsage: new Map(), sessionModelOverride: new Map(), sessionPendingImages: new Map(), sessionProfileIds: new Map(),
    sessionEfforts: new Map(), sessionThreadIds: new Map(), sessionAccountNames: new Map(), nodeActivity: new Map(),
    outboxMoveSession() {}, resetSessionMetrics() {}, notifyNodeStatusListeners() {}, refreshTree() {},
    rememberBoundSessionProfile() {}, persistTranscript() {}, resumedTranscripts: null,
    resumedTranscriptLines: ({ savedLines }) => savedLines.slice(), RESUME_PANEL: { marker: '', continued: '', done: '' },
    statusNote: text => text,
    currentRailTreeNode: shown,
    showTreeNodeControls: fresh => { rebuilds.push(fresh.sessionId); view.mount(fresh) },
    requestAnimationFrame: run => { run(); return 0 },
  })
  view.controlsPage.classList.add('is-active')
  vm.runInContext(`${functionSource('deferRailRebuildWhileTyping')}
    let railStreamFrame = 0, railStreamSessionId = null
    ${functionSource('scheduleRailStream')}
    async function resumeTail() { ${tailSource} }
    function railDelta(sessionId) { ${railDeltaBranch()} }`, view.context)
  const done = vm.runInContext('resumeTail()', view.context)
  /* The resumed session answers: the words it has streamed so far, then the delta seam. */
  const answer = text => {
    view.context.sessionTurnText.set('resumed-session', text)
    view.context.sessionOpenTurns.set('resumed-session', 'turn-after-resume')
    view.context.railDelta('resumed-session')
  }
  return { view, chat, input, rebuilds, done, answer }
}

test('control: nothing focused -- the resume tail rebuilds the open rail on the resumed session at once', async t => {
  const h = resumeWithOpenRail(t, { focusComposer: false })
  assert.equal(await h.done, 'engine')
  assert.deepEqual(h.rebuilds, ['resumed-session'])
  assert.equal(h.view.rail().sessionId, 'resumed-session')
})

test('B18: the composer still has focus after Enter -- the resumed session\'s reply reaches the open rail chat', async t => {
  const h = resumeWithOpenRail(t, { focusComposer: true })
  assert.equal(await h.done, 'engine')
  assert.deepEqual(h.rebuilds, [], 'the rebuild must still wait for the blur (keystroke protection)')
  assert.equal(h.view.rail().sessionId, 'resumed-session',
    `the open rail still routes by ${h.view.rail().sessionId} while the resumed session answers`)
  h.answer('Resumed and answering.')
  assert.ok(h.view.rail().stream, 'the reply opened no bubble in the open rail chat')
  assert.match(h.chat.textContent, /Resumed and answering\./, 'the reply never reached the open rail chat')
  h.input.dispatch('blur')
  assert.deepEqual(h.rebuilds, ['resumed-session'], 'the deferred rebuild still runs exactly once, on blur')
})

test('B18: a resume of another node leaves the open rail on its own session', async t => {
  const h = resumeWithOpenRail(t, { focusComposer: true, railOnAnotherNode: true })
  assert.equal(await h.done, 'engine')
  assert.equal(h.view.rail().sessionId, 'worker-session')
  assert.equal(h.view.rail().nodeId, 'b18-worker')
  h.input.dispatch('blur')
  assert.deepEqual(h.rebuilds, [], 'a resume of another node must not rebuild this rail')
})
