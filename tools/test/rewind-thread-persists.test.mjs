/* A REWIND THAT ERASES TURNS MUST NOT BE UNDONE BY THE NEXT RESUME.
 *
 * THE DEFECT. shell/agent-host.cjs rewindSession() forks the engine's thread
 * at an earlier turn and moves the SESSION to the fork: "the session keeps
 * its child process; only its threadId moves." bridge.rewind() hands that
 * new thread id back to the caller as `done.threadId`.
 *
 * src/views/computers.js performRewind() reads `done.turnId` to confirm the
 * rewind landed, and then calls persistTranscript(node.sessionId) so the
 * shortened memory survives a restart -- but it never reads `done.threadId`.
 * persistTranscript's own threadId field (src/views/computers.js:3010) is
 * `sessionThreadIds.get(sessionId) || kept?.threadId || null`, and
 * `sessionThreadIds` still names the PRE-REWIND thread: nothing in
 * performRewind ever calls `sessionThreadIds.set` for the fork.
 *
 * THE CONSEQUENCE. The durable record is written with the OLD thread id.
 * Close the app (or just stop the session) and press Resume later:
 * resumeNodeSessionUnguarded reads `saved.threadId` from that same record and
 * asks the engine to `--resume` it -- the pre-fork thread, which still holds
 * every turn the person used Rewind to erase. The chat popup told them
 * "Rewound. I remember everything up to X and nothing after it"; the next
 * Resume silently hands the agent its forgotten memory back.
 *
 * THE FIX. performRewind must capture `done.threadId` into `sessionThreadIds`
 * before persistTranscript reads it -- the same map startDraftNode and
 * resumeNodeSessionUnguarded already keep current on every other path that
 * changes a session's live thread.
 *
 * WHY AN EXTRACTED FUNCTION RATHER THAN A MOUNT: the view is a multi-thousand
 * line closure over a live DOM (echarts, a canvas, a ResizeObserver at module
 * load -- see tools/test/rail-follows-canvas.test.mjs and
 * tools/test/node-remove.test.mjs for the same house pattern). performRewind
 * is sliced out by its own braces and re-instantiated with `new Function`
 * over fakes that mirror exactly what it reads and writes, including a
 * `persistTranscript` stand-in that performs the SAME `sessionThreadIds.get`
 * read the real one does at src/views/computers.js:3010 -- so this proves the
 * actual persisted value, not merely that some identifier appears in the
 * source text.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { REWIND_PANEL } from '../../src/fleet-tree-copy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const code = view
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))

function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.ok(at !== -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

const rewindSource = () => sliceBlock(code, 'async function performRewind(node, turnId, out) {', 'performRewind')

/** performRewind, instantiated over fakes that support exactly what it uses.
 *  `persistTranscript` mirrors the real one's threadId precedence
 *  (sessionThreadIds first, then the kept record, then null) so `persisted`
 *  is what would actually land on disk. */
function instantiateRewind({ rewindResult = null, rewindError = null, busy = false } = {}) {
  const sessionThreadIds = new Map()
  const sessionTurnLog = new Map()
  const sessionTranscripts = new Map()
  const nodeReplies = new Map()
  const nodeActivity = new Map()
  const nodeLastTool = new Map()
  const persisted = []
  const kept = new Map()
  const persistTranscript = sessionId => {
    persisted.push({
      sessionId,
      threadId: sessionThreadIds.get(sessionId) || kept.get(sessionId)?.threadId || null,
    })
  }
  const setNodeStatusCalls = []
  const refreshed = []
  const graph = { refreshConversation: nodeId => refreshed.push({ nodeId, threadId: persisted.at(-1)?.threadId }) }
  const treeStore = {
    setNodeReply: () => {},
    setNodeStatus: (id, status, opts) => setNodeStatusCalls.push({ id, status, opts }),
    getNode: () => null,
  }
  const window = {
    mcAgent: {
      rewind: async () => {
        if (rewindError) throw rewindError
        return rewindResult
      },
    },
  }
  const factory = new Function(
    'window', 'nodeBusy', 'REWIND_PANEL', 'sessionTurnLog', 'sessionTranscripts',
    'persistTranscript', 'resetSessionMetrics', 'nodeReplies', 'nodeActivity', 'nodeLastTool',
    'treeStore', 'statusNote', 'showTreeNodeControls', 'sessionThreadIds', 'refreshTree', 'graph', 'nodeThinking', 'refreshWorkspaceChats',
    `${rewindSource()}\nreturn performRewind`,
  )
  const performRewind = factory(
    window, () => busy, REWIND_PANEL, sessionTurnLog, sessionTranscripts,
    persistTranscript, () => {}, nodeReplies, nodeActivity, nodeLastTool,
    treeStore, sentence => sentence, () => {}, sessionThreadIds, () => {}, graph, new Map(), () => {},
  )
  return { performRewind, sessionThreadIds, persisted, setNodeStatusCalls, refreshed }
}

test('a rewind persists the FORKED thread id, not the one the session started on', async () => {
  const { performRewind, sessionThreadIds, persisted, refreshed } = instantiateRewind({
    rewindResult: { sessionId: 's1', threadId: 'thread-forked-2', turnId: 't1' },
  })
  sessionThreadIds.set('s1', 'thread-original-1')
  const node = { id: 'node-1', sessionId: 's1' }

  const ok = await performRewind(node, 't1', null)
  assert.equal(ok, true, 'a rewind whose turnId matches must report success')

  assert.equal(sessionThreadIds.get('s1'), 'thread-forked-2',
    'sessionThreadIds still names the pre-rewind thread -- the map every other path keeps current on a thread change was never updated here')
  assert.equal(persisted.at(-1)?.threadId, 'thread-forked-2',
    'persistTranscript wrote the STALE pre-rewind thread id to the durable record -- the next Resume will --resume that thread and hand the agent back every turn Rewind just erased')
  assert.deepEqual(refreshed, [{ nodeId: node.id, threadId: 'thread-forked-2' }], 'Conversation refresh must follow the accepted fork persistence')
})

test('a refused rewind (busy, or the engine refuses) never touches the thread map', async () => {
  const busyRun = instantiateRewind({ busy: true })
  busyRun.sessionThreadIds.set('s1', 'thread-original-1')
  const busyOk = await busyRun.performRewind({ id: 'node-1', sessionId: 's1' }, 't1', null)
  assert.equal(busyOk, false)
  assert.equal(busyRun.sessionThreadIds.get('s1'), 'thread-original-1', 'a busy refusal must not touch the recorded thread')
  assert.deepEqual(busyRun.refreshed, [])

  const failedRun = instantiateRewind({ rewindError: Object.assign(new Error('nope'), { code: 'AGENT_ENGINE_INVALID_SESSION' }) })
  failedRun.sessionThreadIds.set('s1', 'thread-original-1')
  const failedOk = await failedRun.performRewind({ id: 'node-1', sessionId: 's1' }, 't1', null)
  assert.equal(failedOk, false)
  assert.equal(failedRun.sessionThreadIds.get('s1'), 'thread-original-1', 'a failed fork must not touch the recorded thread')
  assert.deepEqual(failedRun.refreshed, [])
})
