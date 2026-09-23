import assert from 'node:assert/strict'
import test from 'node:test'

import { executeFreshStartBriefSend } from '../../src/fresh-start-brief-send.js'

const node = Object.freeze({ id: 'node-shadow', treeId: 'tree-main', message: 'Chase down the flaky suite.' })

function rig(overrides = {}) {
  const order = []
  const sends = []
  const transcriptEntries = []
  const turnLogEntries = []
  const statuses = []
  const sessionNodeIds = new Map([['session-new', node.id]])
  const sessionThreadIds = new Map([['session-new', 'thread-new']])
  const bridge = {
    async send(request) { sends.push(request); order.push('send'); return { ok: true, turnId: 'turn-new' } },
    ...overrides.bridge,
  }
  return {
    order, sends, transcriptEntries, turnLogEntries, statuses, sessionNodeIds, sessionThreadIds,
    execute(extra = {}) {
      return executeFreshStartBriefSend({
        node,
        sessionId: 'session-new',
        selfName: 'Worker',
        parentName: 'Manager',
        childNames: [],
        bridge,
        sessionNodeIds,
        sessionThreadIds,
        appendTranscript(sessionId, entry) { transcriptEntries.push([sessionId, { ...entry }]); order.push('persist-transcript') },
        appendTurnLog(sessionId, turnId, text) { turnLogEntries.push([sessionId, turnId, text]); order.push('turn-log') },
        treeStore: {
          setNodeStatus(nodeId, status, detail) { statuses.push([nodeId, status, detail]); order.push(`status:${status}`) },
        },
        refreshTree() { order.push('refresh') },
        refusalCodeFromError: error => error?.code || null,
        refusalCodeFromResult: result => result?.code || null,
        ...extra,
      })
    },
  }
}

test('a restarted node is sent the tree address, through the ordinary send API', async () => {
  const testRig = rig()

  const result = await testRig.execute()

  assert.equal(result.ok, true)
  assert.equal(testRig.sends.length, 1)
  const sent = testRig.sends[0]
  assert.equal(sent.sessionId, 'session-new')
  assert.match(sent.text, /^Tree address: you are "Worker", and your manager is "Manager"\./m,
    'the tree address contract line must be present so shell\\agent-host.cjs can register the circle')
  assert.deepEqual(testRig.transcriptEntries, [['session-new', { who: 'you', text: sent.text, at: testRig.transcriptEntries[0][1].at, turnStamp: 'turn-new' }]])
})

test('the node\'s own saved message is never resent -- a restart is a clean slate, not a replay', async () => {
  const testRig = rig()

  const result = await testRig.execute()

  assert.equal(result.ok, true)
  assert.equal(testRig.sends.length, 1)
  assert.doesNotMatch(testRig.sends[0].text, /Chase down the flaky suite/,
    'the node\'s original job text must never be resent on a restart -- repeating it could redo real work')
  assert.match(testRig.sends[0].text, /^Tree address: /, 'with no message the brief is the address alone, not a blank line before it')
})

test('a send refusal after a successful bind is reported back, not swallowed', async () => {
  const testRig = rig({
    bridge: {
      async send(request) { testRig.sends.push(request); return { ok: false, code: 'AGENT_PROVIDER_RATE_LIMITED' } },
    },
  })

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_PROVIDER_RATE_LIMITED')
  assert.equal(testRig.transcriptEntries.length, 0)
})

test('the send only reaches a session the caller\'s own event map still binds to this node', async () => {
  const testRig = rig()
  testRig.sessionNodeIds.set('session-new', 'some-other-node')

  const result = await testRig.execute()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_SESSION_NOT_BOUND')
  assert.equal(testRig.sends.length, 0)
})
