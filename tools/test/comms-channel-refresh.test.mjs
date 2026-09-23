import test from 'node:test'
import assert from 'node:assert/strict'
import { channelGroups, messageMatches } from '../../src/comms-feed.js'
const messages = [
  { id: '1', sender: 'Manager', recipient: 'Builder', senderId: 'm1', recipientId: 'b1', text: 'Please review the export.', at: '2026-09-08T10:00:00Z' },
  { id: '2', sender: 'Builder', recipient: 'Manager', senderId: 'b1', recipientId: 'm1', text: 'Export reviewed.', at: '2026-09-08T10:01:00Z' },
  { id: '3', sender: 'Manager', recipient: 'Builder', senderId: 'm2', recipientId: 'b2', text: 'A separate tree.', at: '2026-09-08T10:02:00Z' },
]
test('both directions share a channel, while identically named agents in separate trees remain distinct', () => {
  const channels = channelGroups(messages)
  assert.equal(channels.length, 3)
  assert.deepEqual(channels[0].messages.map(m => m.id), ['1', '2', '3'])
  assert.deepEqual(channels[1].messages.map(m => m.id), ['3'])
  assert.deepEqual(channels[2].messages.map(m => m.id), ['1', '2'])
  assert.notEqual(channels[1].id, channels[2].id)
  assert.equal(channels[2].name, 'Builder ↔ Manager')
})
test('legacy messages without recipients remain visible and examples retain declared empty channels', () => {
  const channels = channelGroups([{ id: 'old', sender: 'Worker', text: 'Retained message.' }], [{ id: 'questions', name: 'Questions' }])
  assert.equal(channels[0].messages.length, 1)
  assert.equal(channels.find(c => c.id === 'agent-tree').messages[0].id, 'old')
  assert.deepEqual(channels.find(c => c.id === 'questions').messages, [])
})
test('search covers sender, recipient, and full body without treating punctuation as code', () => {
  assert.equal(messageMatches(messages[0], 'BUILDER export'), true)
  assert.equal(messageMatches(messages[0], 'Manager missing'), false)
  assert.equal(messageMatches({ text: 'Literal [failed] result' }, '[failed]'), true)
  assert.equal(messageMatches(messages[0], '   '), true)
})

/* T1513. Two trees, each with a Manager and a Builder (circle names are per
   tree), in the shape the owner journal returns: display names, agent ids and
   each side's saved circle. */
const at = m => new Date(Date.parse('2026-09-22T10:00:00Z') + m * 60000).toISOString()
const pairOf = (id, from, fromId, to, toId, m, text) => ({ id, sender: from, senderId: fromId, senderNodeKey: `node-${fromId}`,
  recipient: to, recipientId: toId, recipientNodeKey: `node-${toId}`, at: at(m), text })
const twoTrees = [
  pairOf('a1', 'Manager', 'a-manager', 'Builder', 'a-builder', 1, 'Tree A: fix the invoice export.'),
  pairOf('b1', 'Manager', 'b-manager', 'Builder', 'b-builder', 2, 'Tree B: write the release notes.'),
  pairOf('a2', 'Builder', 'a-builder', 'Manager', 'a-manager', 3, 'Tree A: export fixed.'),
  pairOf('b2', 'Builder', 'b-builder', 'Manager', 'b-manager', 4, 'Tree B: notes drafted.'),
]
const treeNames = new Map([['node-a-manager', 'Invoice export'], ['node-a-builder', 'Invoice export'],
  ['node-b-manager', 'Release notes'], ['node-b-builder', 'Release notes']])

test('two exchanges between same-named agents in different trees are named by their trees', async () => {
  const { labelSameNamedAgents } = await import('../../src/comms-feed.js')
  const labelled = labelSameNamedAgents(twoTrees, nodeKey => treeNames.get(nodeKey))
  const channels = channelGroups(labelled)
  assert.deepEqual(channels.slice(1).map(channel => channel.name).sort(), ['Builder ↔ Manager · Invoice export', 'Builder ↔ Manager · Release notes'])
  assert.deepEqual(labelled.map(message => `${message.sender} → ${message.recipient}`), [
    'Manager · Invoice export → Builder · Invoice export', 'Manager · Release notes → Builder · Release notes',
    'Builder · Invoice export → Manager · Invoice export', 'Builder · Release notes → Manager · Release notes'])
  const agents = [...new Set(labelled.flatMap(message => [message.sender, message.recipient]))].sort()
  assert.deepEqual(agents, ['Builder · Invoice export', 'Builder · Release notes', 'Manager · Invoice export', 'Manager · Release notes'],
    'the Agent filter can offer each of the four agents')
  assert.equal(messageMatches(labelled[1], 'release manager'), true, 'search reaches the tree too')
  assert.deepEqual(twoTrees.map(message => message.sender), ['Manager', 'Manager', 'Builder', 'Builder'], 'the journal rows are not changed')
})

test('same-named agents whose trees cannot be told apart are numbered, never merged', async () => {
  const { labelSameNamedAgents } = await import('../../src/comms-feed.js')
  for (const treeOf of [() => null, () => { throw new Error('unreadable') }, () => 'New tree']) {
    const labelled = labelSameNamedAgents(twoTrees, treeOf)
    assert.deepEqual(labelled.map(message => `${message.sender} → ${message.recipient}`), [
      'Manager · 1 → Builder · 1', 'Manager · 2 → Builder · 2', 'Builder · 1 → Manager · 1', 'Builder · 2 → Manager · 2'])
    const names = channelGroups(labelled).slice(1).map(channel => channel.name).sort()
    assert.deepEqual(names, ['Builder · 1 ↔ Manager · 1', 'Builder · 2 ↔ Manager · 2'], 'a number is never said as if it were a tree')
  }
  /* Without saved circles (an older journal) the agent ids still tell them apart. */
  const legacy = twoTrees.map(({ senderNodeKey, recipientNodeKey, ...message }) => message)
  assert.equal(new Set(labelSameNamedAgents(legacy).map(message => message.sender)).size, 4)
})

test('names only one agent answers to are left exactly as they were', async () => {
  const { labelSameNamedAgents } = await import('../../src/comms-feed.js')
  const unique = messages.slice(0, 2)
  assert.equal(labelSameNamedAgents(unique, () => 'Invoice export'), unique)
  const single = [pairOf('a1', 'Manager', 'a-manager', 'Builder', 'a-builder', 1, 'one tree only')]
  assert.equal(labelSameNamedAgents(single, () => 'Invoice export'), single)
  assert.equal(channelGroups(labelSameNamedAgents(single, () => 'Invoice export'))[1].name, 'Builder ↔ Manager')
})
