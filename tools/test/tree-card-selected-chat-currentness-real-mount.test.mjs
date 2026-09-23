/* T736: the owner reported the latest assistant reply appearing in the tree
   card but not in the selected chat. This mounts the REAL Computers view
   (tools/test/lib/tree-command-real-mount.mjs, the team's shared real-source
   harness) and drives one session through a stream delta then a final
   turn_completed through the view's own event door (world.bridge.onEvent),
   the same convention tools/test/desktop-person-turn-display.test.mjs and
   tools/test/native-session-reconnect-renderer.test.mjs use. It reads the
   real saved node record AND the real selected/open rail chat
   ([data-rail-chat-host] .chat), opened the same way
   tools/test/tree-rail-details-refresh.test.mjs and
   tools/test/desktop-person-turn-display.test.mjs open it: an Enter+Shift
   keydown on the real tree card (.static-tree-node[data-agent-id]).

   Two orderings are both real user flows and both are asserted:
   (a) the chat is already open live when the reply streams in;
   (b) the person opens the chat only AFTER the turn has already completed,
       which is the native app's saved-conversation reconnect path and
       requires window.mcTranscripts -- the same native hydration bridge
       tools/test/native-session-reconnect-renderer.test.mjs configures.
       Omitting that bridge (case (c) below) is not a realistic native
       config -- production always wires it -- but is kept as an explicit
       RED/GREEN pair: without it the panel reads "Nothing has been said
       here yet" for a session that plainly has a saved reply; with it, the
       same saved reply renders. That boundary is asserted directly so a
       future change cannot silently reintroduce a dependency on it without
       a visible failure. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const { fleetTreesStorageKey } = await import('../../src/fleet-trees.js')

const FINAL_REPLY = 'THE FINAL WHOLE REPLY FOR T736 REAL MOUNT'

async function mountRunningNode(t, { computerId, nodeId, sessionId, withTranscripts }) {
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  const packets = new Set()
  world.bridge.onEvent = listener => { packets.add(listener); return () => packets.delete(listener) }
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.sessionActivity = async () => ({ ok: true, busy: false, closing: false, lastTurnStatus: 'completed', turnsCompleted: 1 })
  let savedEntries = []
  if (withTranscripts) {
    window.mcTranscripts = {
      list: async () => ({ ok: true, records: [{ computerId, nodeId }] }),
      read: async () => ({ ok: true, entries: savedEntries, metadata: { computerId, nodeId }, before: null }),
      append: async request => { savedEntries.push(...(request.entries || [])); return { ok: true } },
      bind: async () => ({ ok: true }),
      onError: () => () => {},
    }
  }
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'running' })
  const view = await mountView(world, { computerId })
  t.after(() => { view.destroy(); delete window.mcTranscripts; world.restore() })
  const emit = async event => { await Promise.all([...packets].map(listener => listener({ sessionId, event }))); await settle(8) }
  return {
    view, world,
    emit,
    markSaved: () => { savedEntries = [{ id: `agent:${sessionId}:real-mount-turn`, who: 'agent', text: FINAL_REPLY, at: 2, turnStamp: 'real-mount-turn' }] },
    openChat: async () => {
      const card = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId)
      assert.ok(card, 'the seeded node has a real tree card')
      card.dispatch('keydown', { key: 'Enter', shiftKey: true })
      await settle(15)
      return view.el.querySelector('[data-rail-chat-host] .chat')
    },
    savedReply: () => JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId))).nodes.find(node => node.id === nodeId).reply,
  }
}

test('T736 (a): a reply that streams in while the chat is already open appears there directly', async t => {
  const f = await mountRunningNode(t, { computerId: 't736-a-computer', nodeId: 't736-a-node', sessionId: 't736-a-session', withTranscripts: false })
  const chat = await f.openChat()
  assert.ok(chat, 'the selected/open chat is mounted for this node')
  await f.emit({ type: 'assistant_text_delta', turnId: 'real-mount-turn', text: FINAL_REPLY })
  await f.emit({ type: 'turn_completed', turnId: 'real-mount-turn', status: 'completed' })
  await settle(20)
  assert.equal(f.savedReply(), FINAL_REPLY, 'the node record itself must carry the exact final reply')
  const chatNow = f.view.el.querySelector('[data-rail-chat-host] .chat')
  const rows = [...chatNow.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent)
  assert.ok(rows.includes(FINAL_REPLY), `the already-open selected chat must show the same reply the saved record has, saw: ${JSON.stringify(rows)}`)
})

test('T736 (b) GREEN: a reply already completed before the chat is opened still shows there, with the native transcript bridge wired', async t => {
  const f = await mountRunningNode(t, { computerId: 't736-b-computer', nodeId: 't736-b-node', sessionId: 't736-b-session', withTranscripts: true })
  await f.emit({ type: 'assistant_text_delta', turnId: 'real-mount-turn', text: FINAL_REPLY })
  f.markSaved()
  await f.emit({ type: 'turn_completed', turnId: 'real-mount-turn', status: 'completed' })
  await settle(20)
  assert.equal(f.savedReply(), FINAL_REPLY, 'the node record itself must carry the exact final reply before the chat is ever opened')
  const chat = await f.openChat()
  const rows = [...(chat?.querySelectorAll('.them .chat-msg-text') || [])].map(row => row.textContent)
  assert.ok(rows.includes(FINAL_REPLY), `opening the chat afterward must show the same reply already saved on the node, saw: ${JSON.stringify(rows)}`)
})

test('T736 (c): the reply still shows without the transcripts bridge, as long as sessionActivity reports the completed turn -- isolates which real signal actually carries currentness here', async t => {
  const f = await mountRunningNode(t, { computerId: 't736-c-computer', nodeId: 't736-c-node', sessionId: 't736-c-session', withTranscripts: false })
  await f.emit({ type: 'assistant_text_delta', turnId: 'real-mount-turn', text: FINAL_REPLY })
  await f.emit({ type: 'turn_completed', turnId: 'real-mount-turn', status: 'completed' })
  await settle(20)
  assert.equal(f.savedReply(), FINAL_REPLY, 'the node record still carries the exact final reply')
  const chat = await f.openChat()
  const rows = [...(chat?.querySelectorAll('.them .chat-msg-text') || [])].map(row => row.textContent)
  assert.ok(rows.includes(FINAL_REPLY),
    `sessionActivity answering the completed turn is enough on its own; a fixture missing THAT (not the transcripts bridge) is what produced the earlier "Nothing has been said here yet" reading -- see tools/test/t736-scratch-diagnose2.mjs, saw: ${JSON.stringify(rows)}`)
})
