import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createFleetTreeStore, safeTreeStorage } from '../../src/fleet-trees.js'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const resumeSource = declaredFunctionSource(source, 'resumeNodeSessionUnguarded')

function fixture() {
  const values = new Map()
  const storage = safeTreeStorage({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  })
  const store = createFleetTreeStore({ computerId: 'resume-fixture', storage })
  const node = store.addNode({ role: 'worker', message: 'Saved conversation', tier: 'luna' }).node
  store.attachSession(node.id, 'old-session')
  store.setNodeStatus(node.id, 'finished')
  const nodes = new Map([[node.id, node]])
  const sessionNodeIds = new Map([['old-session', node.id]])
  const sessionTranscripts = new Map()
  const sessionEfforts = new Map()
  const starts = []
  let blocked = true
  const closes = []
  const saved = { threadId: 'saved-thread', provider: 'codex', account: 'saved-account', lines: [] }
  const transcripts = { ready: Promise.resolve(), readLatest: async () => saved, get: () => saved }
  const bridge = {
    async close(request) { closes.push(request); return { ok: true, closed: true, sessionId: request.sessionId } },
    async start(request) {
      starts.push(request)
      if (blocked) return { ok: false, code: 'AGENT_RESUME_ACCOUNT_LIMIT' }
      return { ok: true, sessionId: 'new-session', threadId: 'saved-thread', resumed: { turns: [] } }
    },
  }
  const context = {
    treeStore: store, transcriptStore: transcripts, window: { mcAgent: bridge }, destroyed: false,
    sessionNodeIds, sessionTranscripts, sessionEfforts, sessionThreadIds: new Map(), sessionAccountNames: new Map(),
    sessionTranscripts, sessionTurnLog: new Map(), sessionUsage: new Map(), sessionModelOverride: new Map(),
    sessionPendingImages: new Map(), sessionProfileIds: new Map(), nodeActivity: new Map(),
    START_CONTROL_FLAG: 'agent-session', isWriteEnabled: () => true, nodeCleanupPending: () => false,
    resumableThread: value => ({ threadId: value.savedThreadId, reason: null }),
    LAUNCH_TIERS: [{ id: 'luna', provider: 'codex' }], startProfileId: value => value || null,
    savedSessionEffort: () => null, tierEffortOf: () => null, nodeRequestKeys: () => null,
    nodeTreeIdentity: () => ({ selfName: 'Worker', managerName: 'Controller' }), treeNodeName: value => value.id,
    identityRoleForTreeNode: () => 'worker', ensureSeatForNode: async () => ({ ok: true }),
    roleBindingForStart: () => ({ ok: true, binding: { agentId: 'agent-1' } }),
    withRetainedStartIdentity: value => value, retainTreeSessionCleanup: () => {},
    statusNote: value => value, startCleanupSentence: () => 'cleanup pending',
    savedAccountResumeRefused: code => code === 'AGENT_RESUME_ACCOUNT_LIMIT', isResourceHold: () => false,
    refusalCode: error => error?.code || null, refusalCodeOf: value => value?.code || null,
    readerRemedy: value => value, startRefusalSentence: () => 'account limit', currentDataSource: () => 'local',
    RESUME_PANEL: { failed: 'resume failed', continued: 'continued', done: 'done', marker: 'marker' },
    setOrgStatus: () => {}, refreshTree: () => {}, rebindRailToSession: () => {},
    outboxMoveSession: () => {}, resetSessionMetrics: () => {}, notifyNodeStatusListeners: () => {},
    sessionThreadIds: new Map(), sessionAccountNames: new Map(), sessionEfforts, sessionProfileIds: new Map(),
    sessionTranscripts, sessionTurnLog: new Map(), sessionUsage: new Map(), sessionModelOverride: new Map(), sessionPendingImages: new Map(),
    nodeActivity: new Map(), resumedTranscriptLines: () => [], persistTranscript: () => {},
    endedAgentStartOutcome: value => ({ ok: false, ...value }), nodeReplacementFlight: { busy: () => false },
    graph: { refreshConversation: () => {} }, deferRailRebuildWhileTyping: callback => callback(),
    controlsPage: { classList: { contains: () => false } }, currentRailTreeNode: null, showTreeNodeControls: () => {},
    rememberBoundSessionProfile: () => {}, retireTreeSessionRuntime: () => {},
    outboxTakeNext: () => null, startAgentForNode: async () => ({ ok: false }),
  }
  vm.runInNewContext(`${resumeSource}; this.resumeNodeSessionUnguarded = resumeNodeSessionUnguarded`, context)
  return { context, node, store, starts, closes, setBlocked: value => { blocked = value }, sessionNodeIds }
}

test('renderer resume keeps predecessor maps on host refusal, then admits replacement', async () => {
  const f = fixture()
  const currentNode = () => f.store.getNode(f.node.id)
  assert.equal(await f.context.resumeNodeSessionUnguarded(currentNode(), { deliverQueued: false }), false)
  assert.equal(f.starts.length, 1)
  assert.equal(f.closes.length, 0)
  assert.equal(f.starts[0].replacesSessionId, 'old-session')
  assert.equal(f.sessionNodeIds.get('old-session'), f.node.id)
  assert.equal(f.store.getNode(f.node.id).sessionId, 'old-session')
  f.setBlocked(false)
  assert.equal(await f.context.resumeNodeSessionUnguarded(currentNode(), { deliverQueued: false }), 'engine')
  assert.equal(f.starts.length, 2)
  assert.equal(f.closes.length, 0)
  assert.equal(f.sessionNodeIds.has('old-session'), false)
  assert.equal(f.sessionNodeIds.get('new-session'), f.node.id)
})
