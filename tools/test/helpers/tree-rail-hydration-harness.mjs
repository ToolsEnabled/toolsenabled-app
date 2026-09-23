import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createNodeTranscriptClient } from '../../../src/node-transcript-client.js'
import { mountTranscriptHistory } from '../../../src/node-transcript-history.js'
import * as fleetCopy from '../../../src/fleet-tree-copy.js'
import { createDrafts, createRailView, functions, functionSource, viewSource } from './tree-rail-chat-harness.mjs'

// Execute the actual foreground client-construction block. The recovery
// coordinator's independent client intentionally has no view callback.
const clientBlocks = []
function visit(node, ancestors = []) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'CallExpression' && node.callee.name === 'createNodeTranscriptClient'
      && node.arguments[0]?.properties?.some(property => property.key.name === 'onError')) {
    clientBlocks.push(ancestors.findLast(parent => parent.type === 'BlockStatement'))
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, [...ancestors, node]))
    else if (value && typeof value === 'object') visit(value, [...ancestors, node])
  }
}
visit(functions.get('openTreeStore'))
assert.equal(clientBlocks.length, 1, 'measure exactly the foreground client construction')
const clientSource = viewSource.slice(clientBlocks[0].start + 1, clientBlocks[0].end - 1)

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const nodeA = { id: 'hydration-node-a', sessionId: 'hydration-session-a', message: 'First question A', reply: 'Latest reply A', role: 'default' }
export const nodeB = { id: 'hydration-node-b', sessionId: 'hydration-session-b', message: 'First question B', reply: 'Latest reply B', role: 'default' }
export const savedA = [
  { id: 'a1', who: 'you', text: nodeA.message, at: 1 },
  { id: 'a2', who: 'agent', text: 'First answer A', at: 2 },
  { id: 'a3', who: 'you', text: 'Second full Stop question A', at: 3 },
  { id: 'a4', who: 'agent', text: 'qa-full-stop-second-proof.txt', at: 4 },
  { id: 'a5', who: 'you', text: 'Third question A', at: 5 },
  { id: 'a6', who: 'agent', text: nodeA.reply, at: 6 },
]
export const savedB = [{ id: 'b1', who: 'you', text: 'Only B history', at: 1 }, { id: 'b2', who: 'agent', text: 'Only B answer', at: 2 }]

/* `older`: a page of messages kept on disk before the newest page, the shape a
   long saved conversation has (the store answers the newest page with a
   `before` cursor, and that cursor reads the older page). */
/* `saved`: replaces node A's saved record. `realActions`: draw saved action rows
   through the view's actual savedActionRow and mergeActionsIntoHistory instead of
   passing them through. */
export function createHydrationView(buildChat, { older = null, saved = null, realActions = false } = {}) {
  const gate = deferred()
  const records = new Map([[nodeA.id, structuredClone(saved || savedA)], [nodeB.id, structuredClone(savedB)]])
  const originalRecords = JSON.stringify([...records])
  const writes = [], warnings = [], refreshes = []
  const nodes = new Map([[nodeA.id, { ...nodeA }], [nodeB.id, { ...nodeB }]])
  const bridge = {
    list: async () => { await gate.promise; return { ok: true, records: [...records.keys()].map(nodeId => ({ nodeId })) } },
    read: async ({ nodeId, before }) => older && nodeId === nodeA.id
      ? (before === 'older-page'
        ? { ok: true, metadata: { nodeId }, entries: structuredClone(older), before: null }
        : { ok: true, metadata: { nodeId }, entries: structuredClone(records.get(nodeId) || []), before: 'older-page' })
      : ({ ok: true, metadata: { nodeId }, entries: structuredClone(records.get(nodeId) || []), before: null }),
    append: async request => { writes.push(request); return { ok: true } },
  }
  const view = createRailView({ buildChat, drafts: createDrafts(), extra: {
    document, window: { mcTranscripts: bridge, addEventListener() {}, removeEventListener() {} },
    createNodeTranscriptClient, mountTranscriptHistory,
    TRANSCRIPT_OLDER_NOTE: fleetCopy.TRANSCRIPT_OLDER_NOTE, TRANSCRIPT_OLDER_DOOR: fleetCopy.TRANSCRIPT_OLDER_DOOR,
    TRANSCRIPT_TRIMMED_NOTE: fleetCopy.TRANSCRIPT_TRIMMED_NOTE,
    /* treeChatConfigFor gained the image outbox after this harness was written;
       these rails hold no image messages. */
    imageConversationFor: () => null,
    computerId: 'hydration-computer', destroyed: false,
    treeStore: { getNode: id => nodes.get(id), snapshot: () => ({ nodes: [...nodes.values()] }) },
    transcriptStore: null, setOrgStatus: (...args) => warnings.push(args),
    sessionTranscripts: new Map(), nodeReplies: new Map(), nodeActivity: new Map(), sessionOpenTurns: new Map(), sessionActions: new Map(), sessionModelOverride: new Map(),
    treeChatHeaderMetaFor: () => null, treeNodeName: node => node.id,
    restoreDiffHistory: (_id, lines) => lines.slice(), markTreeContext: lines => lines, mergeActionsIntoHistory: lines => lines,
    openChatDiff() {}, mockSource: () => false, nodeSessionLive: () => false, nodeBusy: () => false,
    ENDED_SESSION: { subtitle: 'Fixture ended session' }, PALETTE_PANEL: { footer: 'Fixture actions' },
    registerChatSurface() {}, registerNodeStatusListener: () => () => {}, outboxList: () => [],
    chatActionRowsFor: () => [], commonChatActionsFor: () => [], currentConfinementLevel: null, SESSION_OUTBOX_EVENT: 'fixture-outbox',
  } })
  const context = view.context
  view.controlsPage.classList.add('is-active')
  vm.runInContext(`${functionSource('treeChatConfigFor')}
    ${functionSource('deferRailRebuildWhileTyping')}
    ${functions.has('refreshHydratedRailChat') ? functionSource('refreshHydratedRailChat') : ''}
    function openTranscript() { ${clientSource}; return transcriptStore }`, context)
  if (realActions) {
    context.actionRowWords = fleetCopy.actionRowWords
    vm.runInContext(`${functionSource('actionTimingFields')}
      ${functionSource('savedActionRow')}
      ${functionSource('mergeActionsIntoHistory')}`, context)
  }
  context.showTreeNodeControls = node => { refreshes.push(node.id); return mount(node.id) }
  const client = context.openTranscript()
  function mount(id = nodeA.id) {
    const node = nodes.get(id)
    context.currentRailTreeNode = node
    return view.mount(node)
  }
  return {
    ...view, context, client, gate, nodes, warnings, writes, refreshes, mount,
    unchangedRecords: () => JSON.stringify([...records]) === originalRecords,
    destroy() { client.dispose(); context.destroyed = true; view.destroy() },
  }
}
