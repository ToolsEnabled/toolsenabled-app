/* THE ONE READER OF THE SAVED CONVERSATIONS, and what it is now required to
 * carry.
 *
 * THE DEFECT THIS FILE EXISTS FOR. src/session-roles.js was extracted from a
 * private savedConversations() inside src/views/home.js, for the metrics page,
 * nine hours after that screen shipped its own. The two were byte-identical and
 * home was never switched over, so from that hour there were two readers of one
 * record and no test anywhere on either of them. The cost arrived with the
 * first widening: the owner asked the activity list to show what each agent
 * SAID, `reply` was already sitting on the node, and both readers took `role`
 * and `message` and dropped everything else.
 *
 * So this pins the shape rather than the wording: the fields the join hands
 * over, the storage face it will accept, and the three ways it is allowed to
 * fail. The suite runs in plain Node, so every storage here is a double -- and
 * one of them is the SHIM the packaged app really installs, because the real
 * one is not a Storage and that difference has already cost this feature a
 * whole run (see tools/home-activity-substance-qa.mjs).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { readSessionRoles, roleForSessionTarget, SESSION_ROLES_READ_FAILED } from '../../src/session-roles.js'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { transcriptStorageKey } from '../../src/session-transcript-store.js'

const COMPUTER = 'pc-one'
const STAMP = '2026-08-18T10:00:00.000Z'

const node = (over = {}) => ({
  id: 'node-a',
  treeId: 'tree-a',
  parentId: null,
  role: 'helper',
  message: 'Assist the coordinator and check in first.',
  status: 'finished',
  statusNote: '',
  reply: '',
  tier: 'claude-sonnet',
  sessionId: 'chat-a',
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})

const forest = (nodes) => JSON.stringify({
  version: 1,
  computerId: COMPUTER,
  trees: [{ id: 'tree-a', name: 'Work', createdAt: STAMP, updatedAt: STAMP, profileId: null }],
  nodes,
})

/* THE STORAGE THE PACKAGED APP REALLY HAS. public/durable-storage.js replaces
   the global with a shim that exposes the Storage METHODS and nothing else, so
   `Object.keys(store)` answers ["getItem","setItem",...] and finds no saved key
   ever. A reader written against a plain object passes every unit test and
   silently finds nothing in the installed application, which is exactly what
   happened once already. Everything below is read through this shape. */
function shimStorage(entries = {}) {
  const keys = Object.keys(entries)
  return {
    get length() { return keys.length },
    key(index) { return keys[index] ?? null },
    getItem(name) { return Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : null },
    setItem() { throw new Error('this reader must never write') },
    removeItem() { throw new Error('this reader must never write') },
    clear() { throw new Error('this reader must never write') },
  }
}

test('the join hands over the answer, not only the question', () => {
  const found = readSessionRoles(shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node({ reply: 'Checked in and started on the log.' })]),
  }))
  const said = found.get('chat-a')
  assert.equal(said.role, 'helper', 'the metrics join lost the field it was extracted for')
  assert.equal(said.asked, 'Assist the coordinator and check in first.')
  assert.equal(said.reply, 'Checked in and started on the log.',
    'the answer is on the node and the reader drops it, which is the owner’s report unfixed')
  assert.equal(said.status, 'finished')
  assert.equal(said.tier, 'claude-sonnet')
  assert.equal(said.nodeId, 'node-a')
  assert.equal(said.treeId, 'tree-a', 'the full-page tree scope needs the recorded tree identity')
  assert.equal(said.computerId, COMPUTER, 'the reader cannot say which computer a node belongs to')
})

/* The pair the metrics page reads. Its join is documented in
   src/local-metrics.js runRows() as {role, asked} and it must keep meaning
   exactly that, whatever else rides alongside. */
test('the two fields the metrics page joins on keep their names and their meaning', () => {
  const found = readSessionRoles(shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node()]),
  }))
  assert.deepEqual(
    Object.entries(found.get('chat-a')).filter(([key]) => key === 'role' || key === 'asked'),
    [['role', 'helper'], ['asked', 'Assist the coordinator and check in first.']],
  )
})

/* THE CONVERSATION OUTLIVES THE NODE'S ONE REPLY FIELD. The transcripts are
   kept per NODE under their own key per computer, and a node whose reply was
   cleared still has everything that was said in it. Costs one extra read per
   computer, so it is asked for by name and no other caller pays for it. */
test('the saved conversation is read only when it is asked for', () => {
  const store = shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node({ reply: '' })]),
    [transcriptStorageKey(COMPUTER)]: JSON.stringify({
      v: 1,
      nodes: {
        'node-a': {
          savedAt: Date.parse(STAMP),
          threadId: null,
          effort: null,
          lines: [
            { who: 'you', text: 'Check the build.', at: null },
            { who: 'agent', text: 'The build failed on the second step.', at: null },
            { who: 'you', text: 'Thanks.', at: null },
          ],
        },
      },
    }),
  })
  assert.equal(readSessionRoles(store).get('chat-a').said, '',
    'every caller now pays for a transcript read it did not ask for')
  assert.equal(readSessionRoles(store, { transcripts: true }).get('chat-a').said,
    'The build failed on the second step.',
    'the last thing the agent said is unreachable, so a node with no reply shows no answer')
})

test('the last word taken is the agent’s own, never the person’s', () => {
  const found = readSessionRoles(shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node()]),
    [transcriptStorageKey(COMPUTER)]: JSON.stringify({
      v: 1,
      nodes: {
        'node-a': {
          savedAt: Date.parse(STAMP),
          threadId: null,
          effort: null,
          lines: [
            { who: 'agent', text: 'Done.', at: null },
            { who: 'you', text: 'Now do the other one.', at: null },
          ],
        },
      },
    }),
  }), { transcripts: true })
  assert.equal(found.get('chat-a').said, 'Done.',
    'the row would show the person their own words back as the agent’s answer')
})

/* THE THREE FAILURES, AND NONE OF THEM MAY THROW. A screen calls this inside a
   repaint; anything that throws here takes the page down over a record it does
   not even need. */
test('missing storage is absent, but a busy inventory is could-not-tell and is not latched', () => {
  assert.equal(readSessionRoles(null), null)
  assert.equal(readSessionRoles({}), null, 'a storage without the Storage methods was trusted')
  let attempts = 0
  const angry = {
    get length() {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return 1
    },
    key() { return fleetTreesStorageKey(COMPUTER) },
    getItem() { return forest([node()]) },
  }
  const failure = readSessionRoles(angry)
  assert.equal(failure.code, SESSION_ROLES_READ_FAILED)
  assert.match(failure.message, /not claiming they are absent/i)
  assert.equal(failure.cause.code, 'EBUSY')

  const recovered = readSessionRoles(angry)
  assert.equal(recovered.get('chat-a').role, 'helper',
    'a transient inventory failure was cached or latched instead of being retried')
  assert.equal(attempts, 2, 'the successful result came from a cache rather than rereading storage')
})

test('a damaged forest costs its own rows and nothing else', () => {
  const found = readSessionRoles(shimStorage({
    'mc.unrelated.key': 'not ours',
    [`${fleetTreesStorageKey('pc-broken')}`]: '{not json',
    [fleetTreesStorageKey(COMPUTER)]: forest([node()]),
  }))
  assert.equal(found.size, 1, 'a damaged record took a sound one down with it')
  assert.equal(found.get('chat-a').role, 'helper')
})

test('a damaged conversation costs a row its last line and nothing else', () => {
  const found = readSessionRoles(shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node({ reply: 'Kept on the node.' })]),
    [transcriptStorageKey(COMPUTER)]: '{not json',
  }), { transcripts: true })
  assert.equal(found.get('chat-a').said, '')
  assert.equal(found.get('chat-a').reply, 'Kept on the node.',
    'a damaged conversation erased an answer the node itself was holding')
})

test('a node with no session cannot be joined to a run and is not offered as one', () => {
  const found = readSessionRoles(shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node({ status: 'draft', sessionId: null })]),
  }))
  assert.equal(found.size, 0)
})


test('voice contact keeps the saved circle name when its provider session rotates', () => {
  const roles = readSessionRoles(shimStorage({
    [fleetTreesStorageKey(COMPUTER)]: forest([node({ id: 'coordinator-node', role: 'coordinator-assistant',
      nameBase: 'Coordinator assistant', nameOrdinal: 1, sessionId: 'old-provider-session' })]),
  }))
  assert.equal(roles.get('old-provider-session').displayName, 'Coordinator assistant')
  const resolved = roleForSessionTarget({ sessionId: 'new-provider-session', agentId: 'coordinator-node' }, roles)
  assert.equal(resolved?.displayName, 'Coordinator assistant')
  assert.equal(resolved?.nodeId, 'coordinator-node')
  assert.equal(roleForSessionTarget({ sessionId: 'unknown', agentId: 'unknown' }, roles), null)
  assert.equal(roleForSessionTarget({ sessionId: 'unknown', agentId: 'coordinator-node' }, null), null)
})
