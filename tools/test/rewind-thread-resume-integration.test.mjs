/* THE REWIND FIX (8d4adab), CARRIED ALL THE WAY TO THE RESUME DECISION.
 *
 * tools/test/rewind-thread-persists.test.mjs proved that performRewind now
 * calls `sessionThreadIds.set(node.sessionId, done.threadId)` before
 * persistTranscript reads that map -- but it proved it against a FAKE
 * persistTranscript (a bare array push) and never touched the module that
 * actually decides what a later Resume does with the saved value
 * (src/tree-resume-decision.js's resumableThread, in this same lane's
 * src/tree-*.js). A fake persistTranscript passes even if the REAL one
 * (src/views/computers.js, ~line 2987) regresses independently -- its own
 * `kept?.threadId` / `kept?.provider` fallbacks, and its read-modify-write
 * through the real bounded transcriptStore (src/session-transcript-store.js,
 * eviction and line-trimming included), are exactly the kind of place a
 * second, differently-shaped bug could hide without this file's fake ever
 * noticing.
 *
 * This file extracts performRewind AND persistTranscript from the same
 * source together (function declarations in one scope hoist to each other,
 * so performRewind's bare `persistTranscript()` call resolves to the real
 * sibling, not a stub), wires persistTranscript to a REAL transcriptStore
 * (the same storage-seam fake session-transcript-store.test.mjs and
 * resume-keeps-the-conversation.test.mjs use), and then feeds the record
 * that lands on "disk" into the REAL resumableThread -- proving the
 * documented consequence end to end: after a rewind, the thread id a Resume
 * would actually be handed is the FORK, not the original.
 *
 * Two cases the original file never exercises:
 *   1. "a resume": does resumableThread's own decision -- not just the saved
 *      field -- point at the forked thread once the real store round-trips it.
 *   2. "a second caller": a SECOND rewind on the same still-open session
 *      (the person rewinds again, further back, without closing the window)
 *      must persist the NEWER fork, not get stuck on the first one and not
 *      revert to the pre-rewind original -- exercised through the same real
 *      store across two consecutive saves, so any eviction/fallback
 *      interaction would show up here and did not in the original test.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { REWIND_PANEL } from '../../src/fleet-tree-copy.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { resumableThread } from '../../src/tree-resume-decision.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const rewindSource = () => declaredFunctionSource(view, 'performRewind')
const persistSource = () => declaredFunctionSource(view, 'persistTranscript')

/** performRewind AND the real persistTranscript, instantiated together over
 *  one real transcriptStore (in-memory storage seam, same shape as
 *  session-transcript-store.test.mjs) so the actual save/get round trip runs,
 *  not a mimic of it. */
function instantiateRewindAndPersist({ computerId = 'suite' } = {}) {
  const cells = new Map()
  const transcriptStore = createTranscriptStore({
    computerId,
    storage: {
      read: key => (cells.has(key) ? cells.get(key) : null),
      write: (key, value) => { cells.set(key, JSON.parse(JSON.stringify(value))); return true },
    },
  })

  const sessionThreadIds = new Map()
  const sessionNodeIds = new Map()
  const sessionTurnLog = new Map()
  const sessionTranscripts = new Map()
  const sessionEfforts = new Map()
  const sessionAccountNames = new Map()
  const nodeReplies = new Map()
  const nodeActivity = new Map()
  const nodeLastTool = new Map()
  const refreshed = []
  const graph = { refreshConversation: nodeId => refreshed.push({ nodeId, threadId: transcriptStore.get(nodeId)?.threadId }) }

  const nodes = new Map()
  const treeStore = {
    getNode: id => nodes.get(id) || null,
    setNodeReply: () => {},
    setNodeStatus: () => {},
  }

  let rewindPlan = []
  const window = {
    mcAgent: {
      rewind: async () => {
        const next = rewindPlan.shift()
        if (!next) throw new Error('instantiateRewindAndPersist: no rewind result queued')
        if (next.error) throw next.error
        return next.result
      },
    },
  }

  const workspaceRefreshes = []
  const factory = new Function(
    'window', 'nodeBusy', 'REWIND_PANEL', 'sessionTurnLog', 'sessionTranscripts',
    'resetSessionMetrics', 'nodeReplies', 'nodeActivity', 'nodeLastTool',
    'treeStore', 'statusNote', 'showTreeNodeControls', 'sessionThreadIds', 'refreshTree', 'graph',
    'transcriptStore', 'sessionNodeIds', 'LAUNCH_TIERS', 'sessionEfforts', 'sessionAccountNames', 'refreshWorkspaceChats', 'nodeThinking',
    `${persistSource()}\n${rewindSource()}\nreturn performRewind`,
  )
  const performRewind = factory(
    window, () => false, REWIND_PANEL, sessionTurnLog, sessionTranscripts,
    () => {}, nodeReplies, nodeActivity, nodeLastTool,
    treeStore, sentence => sentence, () => {}, sessionThreadIds, () => {}, graph,
    transcriptStore, sessionNodeIds, LAUNCH_TIERS, sessionEfforts, sessionAccountNames,
    (nodeId, force) => workspaceRefreshes.push({ nodeId, force }), new Map(),
  )

  return {
    performRewind, workspaceRefreshes,
    transcriptStore,
    sessionThreadIds,
    sessionNodeIds,
    sessionTurnLog,
    refreshed,
    treeStore: { nodes, ...treeStore },
    queueRewind: result => { rewindPlan.push({ result }) },
  }
}

test('resumableThread, fed the REAL saved record, targets the fork after a rewind -- not the pre-rewind thread', async () => {
  const env = instantiateRewindAndPersist()
  const nodeId = 'node-1'
  const sessionId = 's1'
  env.treeStore.nodes.set(nodeId, { id: nodeId, tier: 'claude-sonnet' })
  env.sessionNodeIds.set(sessionId, nodeId)
  env.sessionThreadIds.set(sessionId, 'thread-original-1')
  env.sessionTurnLog.set(sessionId, [
    { turnId: 't0', yourText: 'first message' },
    { turnId: 't1', yourText: 'the message to keep' },
  ])
  /* The record a normal turn would already have saved, BEFORE any rewind --
     this is what a real node looks like the moment someone presses Rewind,
     and it is what made the original defect invisible to a fresh-map test:
     sessionThreadIds already held a (stale) truthy entry, so the `|| kept
     ?.threadId` fallback never even ran. */
  env.transcriptStore.save(nodeId, {
    lines: [{ who: 'you', text: 'first message', at: 1 }, { who: 'agent', text: 'ok', at: 2 }],
    threadId: 'thread-original-1',
    effort: 'medium',
    provider: 'claude',
    account: null,
  })

  env.queueRewind({ sessionId, threadId: 'thread-forked-2', turnId: 't1' })
  const ok = await env.performRewind({ id: nodeId, sessionId }, 't1', null)
  assert.equal(ok, true)
  assert.deepEqual(env.workspaceRefreshes, [{ nodeId, force: true }], 'the visible workspace reloads the rewound history even though its session id is unchanged')

  const saved = env.transcriptStore.get(nodeId)
  assert.equal(saved?.threadId, 'thread-forked-2',
    'the REAL transcriptStore record still names the pre-rewind thread -- persistTranscript regressed independently of the sessionThreadIds fix')

  const decision = resumableThread({
    savedThreadId: saved?.threadId ?? null,
    savedProvider: saved?.provider ?? null,
    provider: 'claude',
  })
  assert.equal(decision.reason, null, `resumableThread refused the fork: ${decision.reason}`)
  assert.equal(decision.threadId, 'thread-forked-2',
    'a Resume built on the real saved record would --resume the PRE-rewind thread -- exactly the silently-restored-memory bug the fix claims to have closed, now visible one hop further down the real pipeline')
  assert.notEqual(decision.threadId, 'thread-original-1')
  assert.deepEqual(env.refreshed, [{ nodeId, threadId: 'thread-forked-2' }])
})

test('a second rewind on the same open session persists the NEWER fork -- Resume never lands on the first fork or the original', async () => {
  const env = instantiateRewindAndPersist()
  const nodeId = 'node-1'
  const sessionId = 's1'
  env.treeStore.nodes.set(nodeId, { id: nodeId, tier: 'claude-sonnet' })
  env.sessionNodeIds.set(sessionId, nodeId)
  env.sessionThreadIds.set(sessionId, 'thread-original-1')
  env.sessionTurnLog.set(sessionId, [
    { turnId: 't0', yourText: 'first message' },
    { turnId: 't1', yourText: 'second message' },
  ])
  env.transcriptStore.save(nodeId, {
    lines: [{ who: 'you', text: 'first message', at: 1 }],
    threadId: 'thread-original-1',
    effort: null,
    provider: 'claude',
    account: null,
  })

  env.queueRewind({ sessionId, threadId: 'thread-forked-2', turnId: 't1' })
  const first = await env.performRewind({ id: nodeId, sessionId }, 't1', null)
  assert.equal(first, true)
  assert.equal(env.transcriptStore.get(nodeId)?.threadId, 'thread-forked-2',
    'the first rewind did not persist -- setup is wrong, not the case under test')

  /* The person, still in the same window with the same session, rewinds a
     SECOND time to an even earlier turn -- performRewind's own truncation
     left 't0' in the log, so this is a real reachable target, not a
     contrived turnId. */
  env.queueRewind({ sessionId, threadId: 'thread-forked-3', turnId: 't0' })
  const second = await env.performRewind({ id: nodeId, sessionId }, 't0', null)
  assert.equal(second, true)

  const saved = env.transcriptStore.get(nodeId)
  assert.equal(saved?.threadId, 'thread-forked-3',
    `the second rewind's fork did not win -- got ${JSON.stringify(saved?.threadId)}, so either the first fork stuck or persistence fell back to the pre-rewind original`)

  const decision = resumableThread({
    savedThreadId: saved?.threadId ?? null,
    savedProvider: saved?.provider ?? null,
    provider: 'claude',
  })
  assert.equal(decision.threadId, 'thread-forked-3',
    'Resume, driven off the real record after two rewinds, must continue the SECOND (newer) fork')
  assert.deepEqual(env.refreshed, [{ nodeId, threadId: 'thread-forked-2' }, { nodeId, threadId: 'thread-forked-3' }])
})
