import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { executeFreshStartExistingNode } from '../../src/fresh-start-existing-node.js'
import { executeRestartExistingNodeCommand } from '../../src/restart-existing-node-command.js'
import { executeSendToBoundNode } from '../../src/send-to-bound-node.js'
import { composeNodeBrief, nodeManagerContext } from '../../src/tree-node-brief.js'
import { PALETTE_PANEL, restartRefusalSentence } from '../../src/fleet-tree-copy.js'
import { markRefusalCode, readerRemedy } from '../../src/refusal-copy.js'
import { createDocument } from './lib/dom-stand-in.mjs'

const node = Object.freeze({
  id: 'node-shadow',
  treeId: 'tree-main',
  sessionId: 'session-stale',
  tier: 'claude-opus',
})

test('delegated restart passes its one-use token to both pre-close and start', async () => {
  const f = rig()
  assert.equal((await f.execute({ delegationToken: 'opaque-lifecycle-token' })).ok, true)
  assert.equal(f.closeCalls[0].delegationToken, 'opaque-lifecycle-token')
  assert.equal(f.startCalls[0].delegationToken, 'opaque-lifecycle-token')
})

test('a pre-close grant refusal preserves even a stopped node transcript and never starts', async () => {
  const f = rig({ bridge: { close: async () => { throw Object.assign(new Error('refused'), { code: 'TREE_DELEGATION_REFUSED' }) } } })
  const result = await f.execute({ delegationToken: 'opaque-lifecycle-token' })
  assert.equal(result.code, 'TREE_DELEGATION_REFUSED')
  assert.equal(f.startCalls.length, 0)
  assert.equal(f.removedTranscripts.length, 0)
  assert.equal(f.clearedOutboxes.length, 0)
})

test('delegated restart acknowledges its root before boot turn completion and observes a later refusal', async () => {
  let finish
  const turn = new Promise(resolve => { finish = resolve })
  const sessionNodeIds = new Map([['new-session', 'node-shadow']])
  const statuses = []
  const result = await executeRestartExistingNodeCommand({
    node: { ...node, sessionId: 'new-session', message: 'A bounded boot task.' },
    restarted: { ok: true, sessionId: 'new-session', threadId: 'new-thread' },
    sessionNodeIds, bridge: { send: () => turn }, appendTranscript() {},
    briefContext: {}, treeStore: { setNodeStatus: (...args) => statuses.push(args) },
    acknowledgeRoot: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.firstTurnState, 'submitted')
  finish({ ok: false, code: 'SYNTHETIC_BOOT_REFUSED' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(statuses.at(-1)[1], 'failed')
})

function mapWith(entries = []) {
  return new Map(entries)
}

function rig(overrides = {}) {
  const order = []
  const startCalls = []
  const closeCalls = []
  const clearedOutboxes = []
  const removedTranscripts = []
  const removedDiffs = []
  const attached = []
  const detached = []
  const statuses = []

  const sessionState = {
    nodeIds: mapWith(),
    transcripts: mapWith([['session-stale', ['old transcript']]]),
    turnLog: mapWith([['session-stale', ['old turn']]]),
    usage: mapWith([['session-stale', { tokens: 99 }]]),
    modelOverride: mapWith([['session-stale', 'old-model']]),
    pendingImages: mapWith([['session-stale', ['old-image']]]),
    profileIds: mapWith([['session-stale', 'old-profile']]),
    efforts: mapWith([['session-stale', 'high']]),
    threadIds: mapWith([['session-stale', 'provider-thread-that-must-not-resume']]),
    accountNames: mapWith([['session-stale', 'account-old']]),
    ...overrides.sessionState,
  }
  const nodeState = {
    diffHistories: mapWith([[node.id, ['old diff']]]),
    replies: mapWith([[node.id, 'old reply']]),
    activity: mapWith([[node.id, 'old activity']]),
    lastTool: mapWith([[node.id, 'old tool']]),
    ...overrides.nodeState,
  }
  const treeStore = {
    detachSession(nodeId) { detached.push(nodeId); order.push('detach') },
    attachSession(nodeId, sessionId) {
      assert.equal(sessionState.nodeIds.get(sessionId), nodeId,
        'the event-routing map must exist before the durable tree attachment')
      attached.push([nodeId, sessionId])
      order.push('attach')
      return { ok: true }
    },
    setNodeReply(nodeId, text) { order.push(`reply:${nodeId}:${text}`) },
    setNodeStatus(nodeId, status, detail) { statuses.push([nodeId, status, detail]); order.push(`status:${status}`) },
    ...overrides.treeStore,
  }
  const bridge = {
    async close(request) { closeCalls.push(request); return { ok: true } },
    async start(request) {
      startCalls.push(request)
      order.push('start')
      return { ok: true, sessionId: 'session-new', threadId: 'thread-new', account: 'account-new' }
    },
    ...overrides.bridge,
  }
  const transcriptStore = {
    get(nodeId) { assert.equal(nodeId, node.id); return { effort: 'xhigh', lines: [{ who: 'agent', text: 'stale' }] } },
    remove(nodeId) { removedTranscripts.push(nodeId); order.push('transcript-remove'); return true },
    ...overrides.transcriptStore,
  }
  const diffHistoryStore = {
    remove(nodeId) { removedDiffs.push(nodeId); order.push('diff-remove'); return true },
    ...overrides.diffHistoryStore,
  }

  return {
    order, startCalls, closeCalls, clearedOutboxes, removedTranscripts, removedDiffs,
    attached, detached, statuses, sessionState, nodeState, treeStore, bridge,
    transcriptStore, diffHistoryStore,
    execute(extra = {}) {
      return executeFreshStartExistingNode({
        node,
        bridge,
        sourceIsReal: true,
        // A legacy affirmative snapshot must never override a denied live
        // callback. Keeping it also lets the same regression run on the old API.
        startEnabled: true,
        canStart: () => true,
        sessionState,
        nodeState,
        transcriptStore,
        diffHistoryStore,
        treeStore,
        clearOutbox(sessionId) { clearedOutboxes.push(sessionId); order.push('outbox-clear') },
        resetSessionMetrics(sessionId) { order.push(`metrics-reset:${sessionId}`) },
        notifySessionMappingsChanged() { order.push('mapping-notify') },
        refreshTree() { order.push('refresh') },
        tierEffort: 'medium',
        profileId: 'profile-main',
        requestKeys: ['owner-request-1'],
        treeIdentity: { selfName: 'Shadow', managerName: 'Controller' },
        roleBinding: {
          agentId: 'agent-node-shadow',
          provider: 'claude',
          roleId: 'manager',
          expectedOrgRevision: 3,
          expectedRoleRevision: 2,
        },
        rememberBoundSessionProfile(sessionId, nodeId, profileId) {
          assert.equal(sessionState.nodeIds.get(sessionId), nodeId)
          order.push(`profile:${profileId}`)
        },
        failedNote: 'failed',
        clearedNote: 'cleared',
        refusalCodeFromError: error => error?.code || null,
        refusalCodeFromResult: result => result?.code || null,
        ...extra,
      })
    },
  }
}

test('fresh replacement rechecks consent after closing before clearing the saved work or starting', async () => {
  let release, allowed = true
  const gate = new Promise(resolve => { release = resolve })
  const r = rig({ bridge: { close: async request => { r.closeCalls.push(request); await gate; return { ok: true } } } })
  const pending = r.execute({ canStart: () => allowed })
  assert.equal(r.closeCalls.length, 1)
  allowed = false
  release()
  const result = await pending
  assert.equal(result.code, 'MC_TREE_COMMAND_START_DISABLED')
  assert.deepEqual(r.startCalls, [])
  assert.deepEqual(r.removedTranscripts, [])
  assert.deepEqual(r.removedDiffs, [])
  assert.deepEqual(r.clearedOutboxes, [])
  assert.equal(r.sessionState.transcripts.has('session-stale'), true)
})

test('fresh replacement requires a synchronous explicit consent callback', async () => {
  for (const canStart of [undefined, null, () => false, () => 'true', () => Promise.resolve(true), () => { throw new Error('unreadable consent') }]) {
    const r = rig()
    const result = await r.execute({ canStart })
    assert.equal(result.code, 'MC_TREE_COMMAND_START_DISABLED')
    assert.deepEqual(r.closeCalls, [])
    assert.deepEqual(r.startCalls, [])
    assert.deepEqual(r.removedTranscripts, [])
  }
})

test('fresh replacement keeps ownership when consent changes after host dispatch', async () => {
  let allowed = true
  const r = rig({ bridge: { async start(request) {
    r.startCalls.push(request)
    allowed = false
    return { ok: true, sessionId: 'session-new' }
  } } })
  const result = await r.execute({ canStart: () => allowed })
  assert.equal(result.ok, true)
  assert.equal(r.sessionState.nodeIds.get('session-new'), node.id)
  assert.deepEqual(r.attached, [[node.id, 'session-new']])
  assert.equal(r.closeCalls.length, 1)
})

test('a stale close failure is tolerated, all stale state is cleared, and start is clean', async () => {
  const testRig = rig({
    bridge: {
      async close(request) { testRig.closeCalls.push(request); throw Object.assign(new Error('already gone'), { code: 'UNKNOWN_SESSION' }) },
    },
  })

  const result = await testRig.execute()

  assert.deepEqual(result, {
    ok: true,
    code: null,
    nodeId: node.id,
    sessionId: 'session-new',
    threadId: 'thread-new',
  })
  assert.deepEqual(testRig.closeCalls, [{ sessionId: 'session-stale' }])
  assert.deepEqual(testRig.clearedOutboxes, ['session-stale'])
  assert.deepEqual(testRig.removedTranscripts, [node.id])
  assert.deepEqual(testRig.removedDiffs, [node.id])
  for (const map of [
    testRig.sessionState.transcripts,
    testRig.sessionState.turnLog,
    testRig.sessionState.usage,
    testRig.sessionState.modelOverride,
    testRig.sessionState.pendingImages,
    testRig.sessionState.profileIds,
    testRig.sessionState.efforts,
    testRig.sessionState.threadIds,
    testRig.sessionState.accountNames,
  ]) assert.equal(map.has('session-stale'), false)
  for (const map of Object.values(testRig.nodeState)) assert.equal(map.has(node.id), false)

  assert.deepEqual(testRig.startCalls, [{
    surface: 'fleet-tree',
    replacesSessionId: 'session-stale',
    tier: 'claude-opus',
    effort: 'high',
    profileId: 'profile-main',
    roleBinding: {
      agentId: 'agent-node-shadow',
      provider: 'claude',
      roleId: 'manager',
      expectedOrgRevision: 3,
      expectedRoleRevision: 2,
    },
    requestKeys: ['owner-request-1'],
    treeIdentity: { selfName: 'Shadow', managerName: 'Controller' },
  }])
  assert.equal(testRig.sessionState.accountNames.get('session-new'), 'account-new')
  const startRequest = testRig.startCalls[0]
  for (const forbidden of ['resumeThreadId', 'transcript', 'transcriptSeed', 'transcriptSeedText', 'message', 'text', 'prompt']) {
    assert.equal(Object.hasOwn(startRequest, forbidden), false, `clean start carried forbidden ${forbidden}`)
  }
})

test('the event map and tree attachment are live before a successful session id is exposed', async () => {
  const testRig = rig()
  testRig.sessionState.nodeIds.set = function set(sessionId, nodeId) {
    Map.prototype.set.call(this, sessionId, nodeId)
    testRig.order.push('event-map')
    return this
  }

  const result = await testRig.execute()

  assert.equal(result.ok, true)
  assert.equal(testRig.sessionState.nodeIds.get('session-new'), node.id)
  assert.deepEqual(testRig.attached, [[node.id, 'session-new']])
  assert.ok(testRig.order.indexOf('event-map') < testRig.order.indexOf('attach'))
  assert.ok(testRig.order.indexOf('attach') < testRig.order.indexOf('status:finished'))
})

/* MEASURED BY TRACE, not by a packaged repro: detachSession() above already
 * takes this node OUT of LIVE_STATUSES before bridge.start() is even called,
 * and treeStore.removeNode()'s own guard (src/fleet-trees.js) refuses only a
 * LIVE_STATUSES node. bridge.start() is a real, slow call -- spawning a
 * process and resolving an account -- so a Remove pressed on this same node
 * while it is in flight finds nothing to refuse: the store's own live-check
 * sees exactly the drafted, session-less node detachSession() just made.
 *
 * Before this test, the code below trusted `started` unconditionally: it set
 * nodeIds (the event-routing map every liveness check reads as "this run owns
 * this session"), then called treeStore.attachSession(node.id, ...) and threw
 * the answer away without looking at it. attachSession() itself already
 * refuses cleanly when its node is gone (fleet-trees.js: `if (!node) return
 * refuse(...)`) -- the ONLY thing missing was reading that refusal. The
 * result was reported ok:true regardless, with the brand new session
 * registered as owned and pointed at a nodeId the tree had already forgotten
 * -- live, spending, and with nothing on any screen able to reach it, the
 * exact failure nodeReplacementFlight's own header names, reached here
 * through a remove instead of a second replacement. */
test('a node removed while restart\'s own bridge.start was in flight is not left with an orphaned live session', async () => {
  const closeCalls = []
  const testRig = rig({
    treeStore: {
      // The node was removed from the tree by the time start() answered.
      attachSession() { return { ok: false, problems: ['That agent is not on the computer you are driving.'] } },
    },
    bridge: {
      async close(request) { closeCalls.push(request); return { ok: true } },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false, 'a removed node must not be reported as a successful restart')
  assert.equal(testRig.sessionState.nodeIds.has('session-new'), false,
    'the orphaned session must never be left registered as owned once its node is gone')
  assert.equal(testRig.sessionState.efforts.has('session-new'), false)
  assert.equal(testRig.sessionState.threadIds.has('session-new'), false)
  assert.equal(testRig.sessionState.accountNames.has('session-new'), false)
  assert.equal(closeCalls.at(-1)?.sessionId, 'session-new',
    'the just-started, now-unreachable session must be closed rather than left running')
})

test('the clean start exposes the host-composed role introduction without sending it', async () => {
  const testRig = rig({
    bridge: {
      async start(request) {
        testRig.startCalls.push(request)
        return {
          ok: true,
          sessionId: 'session-new',
          threadId: 'thread-new',
          roleIntroduction: 'Your configured role is Builder.',
        }
      },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.roleIntroduction, 'Your configured role is Builder.')
  assert.equal(typeof testRig.bridge.send, 'undefined', 'the fresh helper grew a send operation')
})

test('an assistant-driven restart sends the saved brief only after the fresh session is bound', async () => {
  const order = []
  const sends = []
  const transcript = []
  const statuses = []
  const restartedNode = {
    id: 'node-shadow',
    treeId: 'tree-main',
    parentId: 'node-controller',
    sessionId: 'session-new',
    message: 'Finish the current Page 2 repair.',
  }
  const briefContext = {
    selfName: 'Worker',
    parentName: 'Manager',
    childNames: ['Tester'],
  }
  const sessionNodeIds = mapWith([['session-new', restartedNode.id]])
  const result = await executeRestartExistingNodeCommand({
    node: restartedNode,
    restarted: {
      ok: true,
      code: null,
      nodeId: restartedNode.id,
      sessionId: 'session-new',
      threadId: 'thread-new',
      roleIntroduction: 'Your configured role is Builder.',
    },
    bridge: {
      async send(request) {
        assert.equal(sessionNodeIds.get(request.sessionId), restartedNode.id,
          'the boot turn raced the fresh session binding')
        sends.push(request)
        order.push('send')
        return { ok: true, turnId: 'turn-new' }
      },
    },
    sessionNodeIds,
    briefContext,
    appendTranscript(sessionId, entry) {
      transcript.push([sessionId, entry])
      order.push(`transcript:${entry.text}`)
    },
    treeStore: {
      setNodeStatus(nodeId, status, detail) {
        statuses.push([nodeId, status, detail])
        order.push(`status:${status}`)
      },
    },
    refreshTree() { order.push('refresh') },
    now: () => 1_777_777,
  })

  assert.deepEqual(result, {
    ok: true,
    code: null,
    nodeId: restartedNode.id,
    sessionId: 'session-new',
    threadId: 'thread-new',
  })
  assert.deepEqual(sends, [{
    sessionId: 'session-new',
    text: composeNodeBrief({ message: restartedNode.message, ...briefContext }),
  }])
  assert.deepEqual(transcript.map(([, entry]) => entry.text), [
    restartedNode.message,
    nodeManagerContext(briefContext),
    'Your configured role is Builder.',
  ])
  assert.ok(order.indexOf(`transcript:${restartedNode.message}`) < order.indexOf('send'),
    'a fast reply could arrive before the saved brief was visible in chat')
  assert.ok(order.indexOf('status:running') < order.indexOf('send'))
  assert.deepEqual(statuses.at(-1), [restartedNode.id, 'running', { note: '' }])
})

test('a person-facing clean restart still sends no brief', async () => {
  let sends = 0
  const testRig = rig({
    bridge: {
      async send() { sends += 1 },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, true)
  assert.equal(sends, 0, 'the no-send clean replacement helper re-ran the old ask')
})

test('a refused restart brief is reported and leaves the replacement visible as failed', async () => {
  const statuses = []
  const restartedNode = {
    id: 'node-shadow',
    sessionId: 'session-new',
    message: 'Keep this brief.',
  }
  const result = await executeRestartExistingNodeCommand({
    node: restartedNode,
    restarted: { ok: true, sessionId: 'session-new', threadId: 'thread-new' },
    bridge: {
      async send() { return { ok: false, code: 'AGENT_PROVIDER_RATE_LIMITED' } },
    },
    sessionNodeIds: mapWith([['session-new', restartedNode.id]]),
    briefContext: { selfName: 'Worker', parentName: 'Manager' },
    appendTranscript() {},
    treeStore: {
      setNodeStatus(nodeId, status, detail) { statuses.push([nodeId, status, detail]) },
    },
    failedNote: 'The restart brief was not delivered.',
    refusalCodeFromResult: answer => answer?.code || null,
  })

  assert.deepEqual(result, {
    ok: false,
    code: 'AGENT_PROVIDER_RATE_LIMITED',
    nodeId: restartedNode.id,
    sessionId: 'session-new',
    threadId: 'thread-new',
  })
  assert.deepEqual(statuses.at(-1), [
    restartedNode.id,
    'failed',
    { note: 'The restart brief was not delivered.' },
  ])
})

test('reset refusal blocks start and cannot leave a false live binding', async () => {
  const testRig = rig({
    transcriptStore: { remove() { testRig.removedTranscripts.push(node.id); return false } },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED')
  assert.equal(testRig.startCalls.length, 0)
  assert.equal(testRig.sessionState.nodeIds.has('session-new'), false)
  assert.equal(testRig.attached.length, 0)
  assert.equal(testRig.statuses.at(-1)?.[1], 'failed')
})

/* MEASURED, Controller 2026-09-06: agent.restart refused four different
 * circles with MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED, reproduced both
 * before and after an app restart. The production transcript store
 * (src/node-transcript-client.js, wired in whenever window.mcTranscripts
 * exists) answers `remove()` with a Promise, never the bare `true` this file
 * used to compare against with `!==` -- so a Promise, which is never `===
 * true`, failed the check on every call regardless of whether the reset
 * actually succeeded. These three cases pin the AWAITED contract: a
 * Promise that resolves true must succeed, one that resolves false must
 * still refuse, and one that rejects must refuse with the error's own
 * words, not a caught-and-discarded generic code. */
test('a transcript store whose remove() answers with a Promise is awaited, not read synchronously', async () => {
  const testRig = rig({
    transcriptStore: {
      async remove(nodeId) { testRig.removedTranscripts.push(nodeId); return true },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, true, 'an async remove() that resolves true must not be misread as a failure')
  assert.deepEqual(testRig.removedTranscripts, [node.id])
  assert.equal(testRig.startCalls.length, 1)
})

test('a transcript store whose remove() promise resolves false still refuses the restart', async () => {
  const testRig = rig({
    transcriptStore: { async remove() { return false } },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED')
  assert.equal(testRig.startCalls.length, 0)
})

test('a transcript store whose remove() rejects refuses with the error\'s own message as the reason', async () => {
  const testRig = rig({
    transcriptStore: { async remove() { throw new Error('the transcript folder could not be opened') } },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED')
  assert.equal(result.reason, 'the transcript folder could not be opened')
  assert.equal(testRig.startCalls.length, 0)
})

test('start refusal leaves no new event or tree binding', async () => {
  const testRig = rig({
    bridge: {
      async start(request) {
        testRig.startCalls.push(request)
        return { ok: false, code: 'AGENT_PROVIDER_RATE_LIMITED', sessionId: 'must-not-bind' }
      },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_PROVIDER_RATE_LIMITED')
  assert.equal(testRig.sessionState.nodeIds.has('must-not-bind'), false)
  assert.equal(testRig.attached.length, 0)
  assert.equal(testRig.statuses.at(-1)?.[1], 'failed')
})

test('a renderer-owned live session must close successfully before replacement', async () => {
  const ownedNodeIds = mapWith([['session-stale', node.id]])
  const testRig = rig({
    sessionState: { nodeIds: ownedNodeIds },
    bridge: {
      async close(request) { testRig.closeCalls.push(request); throw new Error('still live') },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_CLOSE_FAILED')
  assert.equal(testRig.startCalls.length, 0)
  assert.equal(ownedNodeIds.get('session-stale'), node.id)
})

/* THE SAME PARITY create-and-start-node.js ALREADY HAS. Its refusals carry a
   bounded `reason` beside the code -- the store's placement sentence, the
   start's own refusal, a thrown error's message -- because src/main.js
   completeTreeNodeCommand and shell/tree-command-refusal-sentences.cjs both
   read `reason` off ANY tree-node-command refusal, not only a create's; the
   errand table there already names 'fresh-start-existing-node' ("restart
   that circle"). This file's own catches had an `error` sitting right there
   and threw its message away, so an assistant's agent.restart came back
   naming only a bare code -- "The application could not restart that circle
   (MC_TREE_COMMAND_CLOSE_FAILED)." -- for a failure whose real cause (a
   provider timeout, a dead child, a permission error) was known the whole
   time and simply never asked for. */
test('a close failure on a session this renderer owns carries the error\'s own words as reason', async () => {
  const ownedNodeIds = mapWith([['session-stale', node.id]])
  const testRig = rig({
    sessionState: { nodeIds: ownedNodeIds },
    bridge: {
      async close(request) { testRig.closeCalls.push(request); throw new Error('the provider did not answer the close in time') },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_CLOSE_FAILED')
  assert.equal(result.reason, 'the provider did not answer the close in time')
})

test('a start that throws while replacing a circle carries the error\'s own words as reason', async () => {
  const testRig = rig({
    bridge: {
      async start(request) {
        testRig.startCalls.push(request)
        throw new Error('the account behind this circle was signed out mid-launch')
      },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_START_FAILED')
  assert.equal(result.reason, 'the account behind this circle was signed out mid-launch')
  assert.equal(testRig.statuses.at(-1)?.[1], 'failed')
})

/* THE OTHER HALF OF THE SAME PARITY. create-and-start-node.js's own start
   branch reads `started.message` on a RETURNED (not thrown) `ok: false`
   result -- see its "a start refusal carries the start's own sentence as its
   reason" test, `fixture({ startResult: { ok: false, message: '...' } })` --
   because a bridge is free to answer a refusal either way: by throwing, or by
   resolving with a result that says so. The two catches above taught this
   file to read an error's `.message` when a call THROWS; this is the sibling
   gap, the same shape one level up, where `bridge.start` resolves instead of
   throwing. Before this test the bare 'start refusal leaves no new event or
   tree binding' case only proved the CODE survives a returned refusal, never
   that its message does -- so a provider that resolves
   `{ ok: false, code, message }` instead of rejecting (exactly the shape
   `refusalCodeFromResult` already exists to read a code off) lost that
   message on the floor while create-and-start-node.js would have kept it. */
test('a start refusal that is returned rather than thrown still carries the result\'s own message as reason', async () => {
  const testRig = rig({
    bridge: {
      async start(request) {
        testRig.startCalls.push(request)
        return { ok: false, code: 'AGENT_PROVIDER_RATE_LIMITED', message: 'This account is rate limited for the next 30 seconds.' }
      },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_PROVIDER_RATE_LIMITED')
  assert.equal(result.reason, 'This account is rate limited for the next 30 seconds.')
  assert.equal(testRig.statuses.at(-1)?.[1], 'failed')
})

test('a refusal with no sentence to give carries no reason key at all', async () => {
  const testRig = rig({
    transcriptStore: { remove() { testRig.removedTranscripts.push(node.id); return false } },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED')
  assert.equal(Object.hasOwn(result, 'reason'), false)
})

function runClearAction(result) {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const action = source.indexOf('  async function runPaletteAction(')
  const from = source.indexOf("    if (id === 'clear') {", action)
  const to = source.indexOf("    if (id === 'resume') {", from)
  assert.ok(action >= 0 && from > action && to > from)
  const document = createDocument()
  const out = document.createElement('p')
  const context = vm.createContext({ node, out, PALETTE_PANEL, restartRefusalSentence, readerRemedy, markRefusalCode,
    freshStartExistingNode: async () => result,
    currentDataSource: () => 'local',
    controlsPage: { classList: { contains: () => false } },
  })
  return vm.runInContext(`(async () => { const id = 'clear'; ${source.slice(from, to)} })()`, context)
    .then(() => out)
}

test('thrown and returned resource refusals retain their cause in the node and the real Start over action', async () => {
  for (const thrown of [false, true]) {
    const testRig = rig({ bridge: {
      async start(request) {
        testRig.startCalls.push(request)
        if (thrown) throw Object.assign(new Error('AGENT_RESOURCE_PRESSURE: private host details'), { code: 'AGENT_RESOURCE_PRESSURE' })
        return { ok: false, code: 'AGENT_RESOURCE_PRESSURE', message: 'private host details' }
      },
    } })
    const result = await testRig.execute({ failedNote: restartRefusalSentence })
    const note = testRig.statuses.at(-1)?.[2].note
    assert.equal(note, restartRefusalSentence(result))
    assert.match(note, /CPU use or app responsiveness.*try Start over again/)
    assert.doesNotMatch(note, /private host details|AGENT_RESOURCE_PRESSURE|retry automatically|old session is closed/)
    const out = await runClearAction(result)
    assert.equal(out.textContent, note)
    assert.equal(out.getAttribute('data-refusal-code'), 'AGENT_RESOURCE_PRESSURE')
    assert.equal(testRig.startCalls.length, 1)
    assert.equal(testRig.attached.length, 0)
  }
})

test('the Start over action does not claim the old session closed when closing it failed', async () => {
  const testRig = rig({
    sessionState: { nodeIds: mapWith([['session-stale', node.id]]) },
    bridge: { async close() { return { ok: false } } },
  })
  const result = await testRig.execute({ failedNote: restartRefusalSentence })
  const out = await runClearAction(result)
  assert.equal(out.textContent, PALETTE_PANEL.clearStopFailed)
  assert.match(out.textContent, /not confirmed closed/)
  assert.equal(testRig.sessionState.nodeIds.get('session-stale'), node.id)
  assert.equal(testRig.removedTranscripts.length, 0)
  assert.equal(testRig.statuses.length, 0)
  assert.equal(testRig.startCalls.length, 0)
})

test('a failed transcript reset keeps its specific reason and never tries the new start', async () => {
  const testRig = rig({ transcriptStore: { remove: () => false } })
  const result = await testRig.execute({ failedNote: restartRefusalSentence })
  assert.match(testRig.statuses.at(-1)?.[2].note, /saved transcript could not be cleared/)
  assert.equal((await runClearAction(result)).textContent, testRig.statuses.at(-1)?.[2].note)
  assert.equal(testRig.startCalls.length, 0)
})

test('unknown restart failures keep uncertainty explicit without rendering raw host text', async () => {
  const result = { ok: false, code: 'NEW_INTERNAL_FAILURE', reason: 'private host details' }
  const out = await runClearAction(result)
  assert.equal(out.textContent, PALETTE_PANEL.clearFailed)
  assert.doesNotMatch(out.textContent, /private host details|old session is closed/)
  assert.equal(out.getAttribute('data-refusal-code'), result.code)
})

function sendRig(overrides = {}) {
  const order = []
  const sends = []
  const transcriptEntries = []
  const turnLogEntries = []
  const statuses = []
  const boundNode = { ...node, sessionId: 'session-new' }
  const sessionNodeIds = mapWith([['session-new', boundNode.id]])
  const sessionThreadIds = mapWith([['session-new', 'thread-new']])
  const command = {
    action: 'send-to-bound-node',
    nodeId: boundNode.id,
    expectedSessionId: 'session-new',
    message: 'Current clean briefing only.',
    ...overrides.command,
  }
  const bridge = {
    async send(request) {
      assert.equal(boundNode.sessionId, command.expectedSessionId,
        'the saved tree binding must match before provider send')
      assert.equal(sessionNodeIds.get(request.sessionId), boundNode.id,
        'the event-routing binding must match before provider send')
      sends.push(request)
      order.push('send')
      return { ok: true, turnId: 'turn-new' }
    },
    ...overrides.bridge,
  }
  return {
    order, sends, transcriptEntries, turnLogEntries, statuses,
    node: overrides.node || boundNode,
    sessionNodeIds: overrides.sessionNodeIds || sessionNodeIds,
    sessionThreadIds,
    command,
    bridge,
    execute(extra = {}) {
      return executeSendToBoundNode({
        command,
        node: overrides.node || boundNode,
        bridge,
        sessionNodeIds: overrides.sessionNodeIds || sessionNodeIds,
        sessionThreadIds,
        appendTranscript(sessionId, entry) {
          transcriptEntries.push([sessionId, { ...entry }])
          order.push('persist-transcript')
        },
        appendTurnLog(sessionId, turnId, text) {
          turnLogEntries.push([sessionId, turnId, text])
          order.push('turn-log')
        },
        treeStore: {
          setNodeStatus(nodeId, status, detail) {
            statuses.push([nodeId, status, detail])
            order.push(`status:${status}`)
          },
        },
        refreshTree() { order.push('refresh') },
        now: () => 1_777_777,
        refusalCodeFromError: error => error?.code || null,
        refusalCodeFromResult: result => result?.code || null,
        ...extra,
      })
    },
  }
}

test('send requires both the expected saved session and the event-router binding', async () => {
  const changed = sendRig({ node: { ...node, sessionId: 'some-other-session' } })
  const changedResult = await changed.execute()
  assert.equal(changedResult.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
  assert.equal(changed.sends.length, 0)
  assert.equal(changed.transcriptEntries.length, 0)

  const unbound = sendRig({ sessionNodeIds: mapWith([['session-new', 'different-node']]) })
  const unboundResult = await unbound.execute()
  assert.equal(unboundResult.code, 'MC_TREE_COMMAND_SESSION_NOT_BOUND')
  assert.equal(unbound.sends.length, 0)
  assert.equal(unbound.transcriptEntries.length, 0)
})

test('confirmed send persists only the validated new message after the bound send', async () => {
  const testRig = sendRig()

  const result = await testRig.execute()

  assert.deepEqual(testRig.sends, [{ sessionId: 'session-new', text: 'Current clean briefing only.' }])
  assert.deepEqual(testRig.transcriptEntries, [[
    'session-new',
    { who: 'you', text: 'Current clean briefing only.', at: 1_777_777, turnStamp: 'turn-new' },
  ]])
  assert.deepEqual(testRig.turnLogEntries, [[
    'session-new', 'turn-new', 'Current clean briefing only.',
  ]])
  assert.deepEqual(result, {
    ok: true,
    code: null,
    nodeId: node.id,
    sessionId: 'session-new',
    threadId: 'thread-new',
  })
  assert.ok(testRig.order.indexOf('send') < testRig.order.indexOf('persist-transcript'),
    'unconfirmed words were persisted before the provider accepted them')
  assert.ok(testRig.order.indexOf('persist-transcript') < testRig.order.indexOf('status:running'))
})

test('invalid or refused send never appends or persists a message', async () => {
  const invalid = sendRig({ command: { message: 'bad\0message' } })
  const invalidResult = await invalid.execute()
  assert.equal(invalidResult.code, 'MC_TREE_COMMAND_MESSAGE_INVALID')
  assert.equal(invalid.sends.length, 0)
  assert.equal(invalid.transcriptEntries.length, 0)

  const refused = sendRig({
    bridge: {
      async send(request) {
        refused.sends.push(request)
        return { ok: false, code: 'AGENT_PROVIDER_RATE_LIMITED' }
      },
    },
  })
  const refusedResult = await refused.execute()
  assert.equal(refusedResult.code, 'AGENT_PROVIDER_RATE_LIMITED')
  assert.equal(refused.sends.length, 1)
  assert.equal(refused.transcriptEntries.length, 0)
  assert.equal(refused.turnLogEntries.length, 0)
  assert.equal(refused.statuses.length, 0)
})
