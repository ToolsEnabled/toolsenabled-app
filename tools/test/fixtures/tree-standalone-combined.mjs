import './tree-box-workspace.mjs'
import { createFleetTreeStore } from '../../../src/fleet-trees.js'
import { createTranscriptStore } from '../../../src/session-transcript-store.js'
import { createSingleFlight } from '../../../src/single-flight.js'
import { adoptStandaloneIntoTree } from '../../../src/tree-standalone-adoption.js'
import { createTurnInterrupts } from '../../../src/turn-interrupts.js'
import { railRebindDecision } from '../../../src/tree-rail-rebind.js'
import { parseSlashCommand } from '../../../src/slash-commands.js'
import { acceptRemoteSequence } from '../../../src/remote-session-history.js'
import * as readers from '../../../src/agent-session-events.js'
import * as copy from '../../../src/fleet-tree-copy.js'

// Actual standalone surface, graph, stores, adoption coordinator, and page
// callback/event/config code. Only provider IPC and unrelated UI hooks are
// synthetic. All persistence is held in this fixture's Map, never native data.
localStorage.setItem('mc.write.agent-session', 'enabled')
const memory = new Map(), storage = { read: key => memory.get(key) ?? null, write: (key, value) => { memory.set(key, value); return true } }
const store = createFleetTreeStore({ computerId: fixture.computer.id, storage })
const transcripts = createTranscriptStore({ computerId: fixture.computer.id, storage })
const parent = store.addNode({ role: 'manager', message: 'Existing parent task' }).node
const maps = Object.fromEntries(['sessionNodeIds', 'sessionThreadIds', 'sessionAccountNames', 'sessionEfforts', 'sessionTranscripts', 'sessionTurnText', 'sessionOpenTurns', 'nodeReplies', 'sessionActions', 'nodeActivity', 'sessionPendingApprovals', 'sessionModelOverride', 'sessionUsage', 'chatSurfaces', 'turnReplies', 'standaloneSettledTurns', 'remotePendingPackets', 'remoteAppliedSequences', 'sessionTurnLog', 'sessionRuleCalls', 'sessionProfileIds', 'sessionPendingImages'].map(key => [key, new Map()]))
const calls = [], listeners = new Set(), statusListeners = new Map()
const state = window.combined = { store, transcripts, maps, calls, listeners, parent, held: false, refusal: false, originals: new Map(), memory }
const bridge = {
  availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
  onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  start: async request => { calls.push(['start', structuredClone(request)]); return { sessionId: request.sessionId, threadId: `provider-${request.sessionId}`, account: 'synthetic-seat' } },
  send: async request => { calls.push(['send', structuredClone(request)]); return { turnId: `turn-${calls.filter(([kind]) => kind === 'send').length}` } },
  interrupt: async request => { calls.push(['interrupt', request]); return { ok: true } },
  close: async request => { calls.push(['close', request]); return { closed: true } },
  adoptTreeAddress: async request => {
    calls.push(['adopt', structuredClone(request)])
    if (state.held) await new Promise(resolve => { state.finish = resolve })
    return state.refusal ? { ok: false, sentence: 'Synthetic host refused placement.' }
      : { ok: true, sessionId: request.sessionId, nodeId: request.requestKeys.threadId, treeKey: request.treeKey, threadId: `provider-${request.sessionId}`, account: 'synthetic-seat' }
  },
}
window.mcAgent = bridge
graph.standaloneAgent = { live: true, bridge }
const treeNodeName = node => `${node.role === 'manager' ? 'Manager' : 'Agent'} ${node.id.slice(-5)}`
const notify = () => { for (const set of statusListeners.values()) for (const listener of set) listener() }
const refreshTree = () => {
  fixture.nodes.splice(0, fixture.nodes.length, ...store.snapshot().nodes.map(node => ({ ...node, name: treeNodeName(node), treeNode: node, state: node.status === 'running' ? 'working' : 'idle', declaredRole: node.role })))
  for (const node of fixture.nodes) if (!fixture.queues.has(node.id)) fixture.queues.set(node.id, [])
  graph.refresh(); notify()
}
const noOp = () => {}
const env = {
  ...readers, ...copy, ...maps, createTurnInterrupts, acceptRemoteSequence, parseSlashCommand, railRebindDecision, controlsPage: { classList: { contains: () => false } }, notePersonSpokeTo: (trees, node) => trees.markPromptedByPerson(node.id),
  replayingRemoteHistory: false, turnInterrupts: createTurnInterrupts(), nodeReplacementFlight: { busy: () => false },
  chatSurfaceSessions: new WeakMap(), chatSpeech: new WeakMap(), chatSpeechMounts: new WeakMap(), chatSpeechPending: new Set(), chatSpeechFrame: 0,
  pickAttachment: null, pickMention: null, pasteAttachment: null,
 destroyed: false, mockSource: () => false, treeStore: store, transcriptStore: transcripts,
  computer: fixture.computer, graph, window, adoptStandaloneIntoTree, treeNodeName, refreshTree,
  startingNodeIds: new Set(), RUN_NODE_REPLACEMENTS: createSingleFlight(), retainStartingTreeStore: () => noOp,
  syncTreeBranchAddresses: async () => {}, TRANSCRIPT_MAX_ENTRIES: 60, LAUNCH_TIERS: [],
  currentRailTreeNode: null, railChat: null, railSaid: null, sessionBreakPending: new Set(), sessionsInterrupted: new Set(),
  recordTurnActions: noOp, notifyNodeStatusListeners: notify, chipRefreshFrame: 0, chipRefreshNodeId: null,
  clearInlineApproval: noOp, outboxTakeNext: () => null, statusNote: value => value,
  treeChatHeaderMetaFor: () => null, nodeSessionLive: node => maps.sessionNodeIds.has(node.sessionId),
  nodeBusy: node => ['starting', 'running'].includes(node.status) && maps.sessionNodeIds.has(node.sessionId),
  nodeStartReason: () => null, restoreDiffHistory: (_id, history) => history, markTreeContext: history => history,
  mergeActionsIntoHistory: history => history, openChatDiff: noOp,
  registerNodeStatusListener: (id, listener) => { const set = statusListeners.get(id) || new Set(); set.add(listener); statusListeners.set(id, set); return () => set.delete(listener) },
  outboxList: () => [], outboxSubscribe: () => noOp, currentConfinementLevel: 'standard',
  chatActionRowsFor: () => [], commonChatActionsFor: () => [], sessionModelChoices: () => [],
}
const extracted = await (await fetch('/__standalone-page-code')).json()
const bindings = new Function(...Object.keys(env), `${extracted.methods.join('\n')}\nconst handleAgentEvent = ${extracted.eventDispatcher}; return {placeStandaloneAgent,treeChatConfigFor,eventHandler:(${extracted.eventHandler})}`)(...Object.values(env))
state.bindings = bindings; state.env = env
// The real page subscribes before subsequently opened standalone surfaces.
const unsubscribePage = bridge.onEvent(bindings.eventHandler)
state.emit = async (id, event) => { await Promise.all([...listeners].map(listener => listener({ sessionId: id, event }))) }
graph.onPlaceStandalone = bindings.placeStandaloneAgent
graph.treeChat = agent => bindings.treeChatConfigFor(store.getNode(agent.id))
graph.canExtend = agent => !agent || !!store.getNode(agent.id)
refreshTree()
graph.treeWindows.choose(graph.treeWindows.windows[0], [parent.id])
state.destroy = () => { graph.destroy(); unsubscribePage(); store.destroy?.(); transcripts.dispose?.() }
state.ready = true
