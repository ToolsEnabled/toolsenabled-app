/* OPENING AN AGENT THAT HAS ALREADY TALKED SHOWS WHAT IT SAID.
 *
 * The owner named resume as part of the chat lifecycle. Worker 82 found the
 * Agent page showing an EMPTY transcript for an agent with a full
 * conversation. mountAgentSessionSurface starts its transcript empty and only
 * ever fills it from live deltas, so the tree chat and the right rail -- which
 * keep a retained mount -- still hold every line, while this page is built
 * fresh on every visit and had nothing to draw until the next delta arrived.
 *
 * NOT THROUGH THE LIVE-SESSION REGISTRY, and this is the part worth recording
 * because it is the obvious route and it is closed on purpose. I tried it
 * first: agent-session-registry.js validates a published record and keeps only
 * { pause, respawn, terminate } off the control, frozen. The owning surface's
 * snapshot -- which does carry the transcript -- is not reachable from there,
 * and my first attempt read as "no conversation" rather than as an error.
 * Widening that object would widen the one thing three destructive controls
 * read, to carry a convenience.
 *
 * session-roles.js is the reader the product already uses for exactly this
 * join; the home activity list and the metrics page both go through it, and a
 * row's `turns` are already buildChat's history shape.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
/* The view imports its own stylesheet, which node cannot load. The same stub
   loader every other suite that touches a view uses. */
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { savedConversationFor, storedConversationFor, computerIdsWithRecords } = await import('../../src/views/agent.js')

const rows = entries => new Map(entries.map((row, index) => [row.sessionId || `session-${index}`, row]))

test('the conversation an agent has already had is what its page is given', () => {
  const found = savedConversationFor('node-7', rows([
    { nodeId: 'node-7', sessionId: 'session-a', turns: [
      { who: 'you', text: 'summarise my notes', at: 1 },
      { who: 'agent', text: 'Here is the summary.', at: 2 },
    ] },
  ]))
  assert.deepEqual(found, [
    { who: 'you', text: 'summarise my notes', at: 1 },
    { who: 'agent', text: 'Here is the summary.', at: 2 },
  ], 'THE DEFECT: the page is handed nothing, so an agent mid-conversation opens blank')
})

test('another agent conversation is never handed to this one', () => {
  const found = savedConversationFor('node-7', rows([
    { nodeId: 'node-9', sessionId: 'session-b', turns: [{ who: 'agent', text: 'not yours', at: 1 }] },
  ]))
  assert.equal(found, null, 'the conversation of a different agent would be shown on this page')
})

test('nothing saved answers null, never an empty history', () => {
  /* buildChat draws its seeded demonstration conversation over an EMPTY
     history. Answering [] would put three invented bubbles on the page of an
     agent that has said nothing, which is worse than showing nothing. */
  assert.equal(savedConversationFor('node-7', rows([])), null)
  assert.equal(savedConversationFor('node-7', rows([{ nodeId: 'node-7', sessionId: 's', turns: [] }])), null,
    'a row with no lines is not an answer')
  assert.equal(savedConversationFor('node-7', null), null, 'an unreadable store must answer null, not throw')
  assert.equal(savedConversationFor('', rows([{ nodeId: '', sessionId: 's', turns: [{ who: 'you', text: 'x', at: 1 }] }])), null,
    'an agent with no id must not match a row with no id')
})

test('a row whose lines are damaged contributes only the sound ones, and none is not an answer', () => {
  const found = savedConversationFor('node-7', rows([
    { nodeId: 'node-7', sessionId: 's', turns: [
      { who: 'you', text: 'kept', at: 1 },
      { who: 'agent', text: '', at: 2 },
      { who: 'agent', at: 3 },
      null,
    ] },
  ]))
  assert.deepEqual(found, [{ who: 'you', text: 'kept', at: 1 }], 'an empty or textless line must not become a blank bubble')
  assert.equal(savedConversationFor('node-7', rows([
    { nodeId: 'node-7', sessionId: 's', turns: [{ who: 'agent', text: '' }, null] },
  ])), null, 'a row whose every line is damaged must answer null rather than an empty history')
})

test('the FIRST row with real lines wins, so an empty later session cannot hide an earlier conversation', () => {
  const found = savedConversationFor('node-7', rows([
    { nodeId: 'node-7', sessionId: 'older', turns: [{ who: 'you', text: 'the real conversation', at: 1 }] },
    { nodeId: 'node-7', sessionId: 'newer', turns: [] },
  ]))
  assert.deepEqual(found, [{ who: 'you', text: 'the real conversation', at: 1 }])
})

/* WHERE THIS BUILD ACTUALLY KEEPS THE CONVERSATION, AND HOW IT IS FOUND.
 *
 * Measured on a running candidate, across an app restart:
 *   localStorage mc.fleet.transcripts.v1:<computerId>   does not exist at all
 *   the node record in mc.fleet.trees.v1                survives, but holds
 *                                                       only the FIRST ask and
 *                                                       the LAST reply
 *   window.mcTranscripts.read({ computerId, nodeId })   TEN entries, the whole
 *                                                       conversation, still
 *                                                       there after a restart
 * So the main process is the durable store and the legacy localStorage one is
 * simply unused here.
 *
 * NOT list(). My first version of this reader discovered the computer through
 * mcTranscripts.list(), and after a restart list() answers with NO RECORDS
 * while read() still returns all ten entries -- so the reader answered null
 * for every agent and the repair was a no-op a second time. list() reports
 * what the run has registered, not what is stored. The computer is derived
 * from the storage keys instead, the same derivation session-roles.js makes:
 * the fleet-trees key is `<base>:<computerId>` and the module that owns the key
 * wrote the prefix.
 */
const bridgeOf = ({ entries = [], readThrows = false } = {}) => ({
  read: async () => { if (readThrows) throw new Error('bridge is gone'); return { ok: true, entries } },
})
const HERE = ['this-computer']

test('the conversation the main process holds is what the page is given', async () => {
  const found = await storedConversationFor('node-2', bridgeOf({ entries: [
    { id: 'you:1', who: 'you', text: 'what colours are in this picture?' },
    { id: 'agent:1', who: 'agent', text: 'Red and yellow.' },
  ] }), HERE)
  assert.deepEqual(found.map(line => line.text), ['what colours are in this picture?', 'Red and yellow.'],
    'THE DEFECT: the page reads a store this build does not use, so every agent looks silent')
})

test('each computer this browser has records for is asked, in turn, until one answers', async () => {
  const asked = []
  const bridge = { read: async request => {
    asked.push(request)
    return request.computerId === 'second' ? { ok: true, entries: [{ who: 'agent', text: 'found', id: 'a' }] } : { ok: true, entries: [] }
  } }
  const found = await storedConversationFor('node-2', bridge, ['first', 'second', 'third'])
  assert.deepEqual(found.map(line => line.text), ['found'])
  assert.deepEqual(asked.map(request => request.computerId), ['first', 'second'],
    'it must stop at the computer that answered, and must not keep asking the rest')
  assert.deepEqual(asked[0], { computerId: 'first', nodeId: 'node-2' }, 'the read must name the agent it is for')
})

test('one computer refusing does not hide a conversation held by another', async () => {
  const bridge = { read: async request => {
    if (request.computerId === 'broken') throw new Error('that one is gone')
    return { ok: true, entries: [{ who: 'you', text: 'still here', id: 'a' }] }
  } }
  const found = await storedConversationFor('node-2', bridge, ['broken', 'working'])
  assert.deepEqual(found.map(line => line.text), ['still here'],
    'a throwing computer ended the search instead of being skipped')
})

test('every way the read can come back empty is the same answer, and it is never an empty history', async () => {
  assert.equal(await storedConversationFor('node-2', null, HERE), null, 'no bridge at all')
  assert.equal(await storedConversationFor('node-2', {}, HERE), null, 'a bridge with no read')
  assert.equal(await storedConversationFor('node-2', bridgeOf({ readThrows: true }), HERE), null, 'read threw')
  assert.equal(await storedConversationFor('node-2', bridgeOf({ entries: [] }), HERE), null,
    'an empty stored conversation must answer null, because [] is what summons the demonstration bubbles')
  assert.equal(await storedConversationFor('node-2', bridgeOf({ entries: [{ who: 'agent' }, null, { who: 'you', text: '' }] }), HERE), null,
    'a record whose every entry is unusable must answer null rather than an empty history')
  assert.equal(await storedConversationFor('', bridgeOf({ entries: [{ who: 'you', text: 'x' }] }), HERE), null,
    'an agent with no id must not be read for')
  assert.equal(await storedConversationFor('node-2', bridgeOf({ entries: [{ who: 'you', text: 'x' }] }), []), null,
    'with no computer to ask, there is nothing to answer')
})

test('the computers are read off the storage keys, and nothing else is mistaken for one', () => {
  const store = new Map([
    ['mc.fleet.trees.v1:this-computer', '{}'],
    ['mc.fleet.trees.v1:another-computer', '{}'],
    ['mc.fleet.transcripts.v1:this-computer', '{}'],
    ['mc.write.agent-session', 'enabled'],
    ['mc.fleet.trees.v1:', '{}'],
  ])
  const storage = {
    get length() { return store.size },
    key: index => [...store.keys()][index] ?? null,
    getItem: key => store.get(key) ?? null,
  }
  assert.deepEqual(computerIdsWithRecords(storage), ['this-computer', 'another-computer'],
    'a transcripts key, an unrelated flag, or a key naming no computer must not become a computer')
  assert.deepEqual(computerIdsWithRecords(null), [], 'no storage is no computers, not a throw')
  assert.deepEqual(computerIdsWithRecords({}), [], 'a storage with no index is no computers, not a throw')
})
