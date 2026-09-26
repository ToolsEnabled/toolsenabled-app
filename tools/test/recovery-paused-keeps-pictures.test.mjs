// T1174, found again 2026-09-25 by the release ratchet: after an account recovery ended
// "Recovery paused", the successor held a retained picture it never received the handoff for,
// and the next status notice anywhere in the tree -- first a chip's background read of the
// Accounts policy (an earlier commit) -- reached the conversation's ready listener and sent it. These
// run the actual tree image conversation (computers.js imageConversationFor) against a
// fake host queue: a notice is not readiness while paused, Send again still sends, and a
// node that is not paused drains exactly as before.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createImageConversation } from '../../src/image-conversation.js'
import { recoveryPausedNode } from '../../src/account-recovery-coordinator.js'

const source = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const start = source.indexOf('  const imageConversations = new Map()')
const end = source.indexOf('  function imageConversationFor(nodeId)', start)
const close = source.indexOf('\n  }\n', end)
assert.ok(start >= 0 && end > start && close > end, 'imageConversationFor moved; re-aim this slice')
const body = source.slice(start, end) + source.slice(end, close + 4)
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }

function mount(node) {
  const ownerContext = { version: 1, ownerId: 'owner', currentEpoch: randomUUID(), kind: 'local' }
  const envelopeId = 'retained-' + randomUUID()
  let snapshot = { version: 1, generation: randomUUID(), destinationSessionId: 'successor', automaticSend: false,
    entries: [{ envelopeId, text: 'the picture it never got the handoff for', state: 'not-sent' }] }
  const dispatches = [], listeners = new Set()
  const bridge = {
    ownerContext: async () => ownerContext,
    onOwnerContextChanged: () => () => {},
    imageQueue: async r => {
      const answer = result => ({ ok: true, operation: r.operation, operationId: r.operationId || null, result })
      if (r.operation === 'binding') return { ok: true, result: { sessionId: r.sessionId, conversationId: 'conversation', ownerContext } }
      if (r.operation === 'read') return answer(structuredClone(snapshot))
      if (r.operation === 'dispatch') {
        dispatches.push(r.envelopeId)
        snapshot = { ...snapshot, generation: randomUUID(), entries: snapshot.entries.map(row => ({ ...row, state: 'accepted' })) }
        return { ...answer(structuredClone(snapshot)), conversationId: 'conversation', sessionId: r.sessionId, envelopeId: r.envelopeId,
          ownerContext, deliveryDisposition: 'accepted', attemptId: randomUUID(), reconcile: false }
      }
      assert.fail('unexpected image queue operation ' + r.operation)
    },
  }
  const prior = globalThis.window
  globalThis.window = { mcAgent: bridge }
  const args = {
    treeStore: { getNode: () => node }, window: globalThis.window, unsubs: [], createImageConversation,
    pendingModelChoice: () => false, pendingModelDrainHolds: new Set(),
    nodeBusy: () => false, nodeSessionEnded: () => false, nodeCleanupPending: () => false, nodeReplacementFlight: { busy: () => false },
    registerNodeStatusListener: (_id, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    recoveryPausedNode,
  }
  const api = new Function(...Object.keys(args), 'let destroyed=false;\n' + body + '\nreturn { imageConversationFor }')(...Object.values(args))
  const conversation = api.imageConversationFor(node.id)
  return {
    conversation, dispatches, envelopeId,
    notice: async () => { for (const listener of [...listeners]) listener(); await settle() },
    restore: () => { conversation.dispose(); globalThis.window = prior },
  }
}

const paused = () => ({ id: 'node', sessionId: 'successor', status: 'turn-failed',
  statusNote: 'Recovery paused: The handoff was refused. The conversation is saved.' })

test('the saved note is what marks a paused recovery, and nothing else does', () => {
  assert.equal(recoveryPausedNode(paused()), true)
  assert.equal(recoveryPausedNode({ ...paused(), statusNote: 'The provider refused this request.' }), false, 'an ordinary failed turn')
  assert.equal(recoveryPausedNode({ ...paused(), status: 'running' }), false, 'a node that moved on')
  assert.equal(recoveryPausedNode(null), false)
})

test('while a recovery is paused, status notices never send the retained picture', async () => {
  const rig = mount(paused())
  try {
    await rig.conversation.refresh()
    await rig.notice(); await rig.notice()
    assert.deepEqual(rig.dispatches, [], 'a notice in the tree is not the successor becoming ready')
  } finally { rig.restore() }
})

test('while a recovery is paused, Send again still sends the picture, once', async () => {
  const rig = mount(paused())
  try {
    const view = await rig.conversation.refresh()
    const result = await rig.conversation.retry(rig.envelopeId, view)
    assert.equal(result?.state, 'accepted', JSON.stringify(result))
    assert.deepEqual(rig.dispatches, [rig.envelopeId])
  } finally { rig.restore() }
})

test('a node that is not paused drains on its ready notice exactly as before', async () => {
  for (const node of [
    { ...paused(), statusNote: 'The provider refused this request.' },
    { ...paused(), status: 'finished', statusNote: '' },
  ]) {
    const rig = mount(node)
    try {
      await rig.conversation.refresh()
      await rig.notice()
      assert.deepEqual(rig.dispatches, [rig.envelopeId], `${node.status}: ${node.statusNote}`)
    } finally { rig.restore() }
  }
})
