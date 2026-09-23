/* THE END-TO-END CASE, WITH NEITHER HALF MOCKED.
 *
 * tools/test/tree-node-command-fresh-start-behavior.test.mjs pins
 * fresh-start-existing-node.js's half of this contract with a plain mock
 * transcriptStore. tools/test/node-transcript-client.test.mjs pins
 * node-transcript-client.js's half in isolation. Neither, alone, proves the
 * two halves agree with each other -- and MEASURED, Controller 2026-09-06,
 * the actual production failure was exactly a disagreement between them: the
 * real client answered `remove()` with a Promise resolving `undefined`
 * (its "nothing to remove, already the goal state" success signal), and the
 * real caller compared that Promise to the literal `true` synchronously.
 *
 * This file wires the two real modules together, with only the bridge (the
 * IPC boundary to shell/node-transcript-store.cjs) faked, and drives the
 * exact case that used to be silently wrong: a node with no cached history,
 * which is precisely where the old remove() resolved `Promise.resolve()`
 * (undefined) as its "success".
 *
 *   node --test tools/test/restart-transcript-reset-real-client.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { executeFreshStartExistingNode } from '../../src/fresh-start-existing-node.js'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

const node = Object.freeze({ id: 'node-real', treeId: 'tree-main', sessionId: null, tier: 'claude-opus' })

function fakeBridge() {
  return {
    async list() { return { ok: true, records: [] } },
    async read() { return { ok: true, metadata: {}, entries: [], before: null, count: 0 } },
    async rollback() { return { ok: true } },
  }
}

test('a restart against a node with no saved history succeeds through the real transcript client, not just a mock', async () => {
  const bridge = createNodeTranscriptClient({ computerId: 'c1', bridge: fakeBridge() })
  await bridge.ready

  const result = await executeFreshStartExistingNode({
    node,
    bridge: { async start() { return { ok: true, sessionId: 'session-new', threadId: null } } },
    sourceIsReal: true,
    canStart: () => true,
    sessionState: { nodeIds: new Map(), transcripts: new Map(), turnLog: new Map(), usage: new Map(),
      modelOverride: new Map(), pendingImages: new Map(), profileIds: new Map(), efforts: new Map(),
      threadIds: new Map(), accountNames: new Map() },
    nodeState: { diffHistories: new Map(), replies: new Map(), activity: new Map(), lastTool: new Map() },
    transcriptStore: bridge,
    treeStore: { detachSession() {}, attachSession() { return { ok: true } }, setNodeReply() {}, setNodeStatus() {} },
    refreshTree() {},
  })

  assert.equal(result.ok, true,
    'the real client\'s "nothing to remove" success case must not be read as MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED')
  assert.equal(result.sessionId, 'session-new')
})
