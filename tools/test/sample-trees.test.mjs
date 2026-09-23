/* The example tree store is the data source used by the computers view when it
 * is showing the sample computer.  Exercise its public face rather than
 * copying the private seed table: these are the facts the tree chips, graph,
 * and agent rail consume.
 *
 * Run: node --test tools/test/sample-trees.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SAMPLE_TREE_COMPUTER_ID,
  createSampleTreeStore,
} from '../../src/sample-trees.js'

function nodesByMessage(store) {
  return new Map(store.listTrees().flatMap(tree => store.listNodes(tree.id))
    .map(node => [node.message, node]))
}

test('the no-argument caller receives the sample computer and three useful trees', () => {
  const store = createSampleTreeStore()
  const trees = store.listTrees()

  assert.equal(store.snapshot().computerId, SAMPLE_TREE_COMPUTER_ID,
    'the sample store must belong to the computer the view uses to cache it')
  assert.equal(trees.length, 3,
    'the example must offer all three tree choices rather than an empty or partial rail')
  assert.deepEqual(trees.map(tree => store.treeLabel(tree.id)), [
    'say hey',
    'what tools do you have access to',
    'can you open chrome',
  ], 'tree labels must describe the three sample requests in their intended order')
  for (const tree of trees) {
    assert.ok(store.rootOf(tree.id), `sample tree '${store.treeLabel(tree.id)}' must have a root agent`)
  }
})

test('sample agents retain hierarchy, lifecycle evidence, and user-facing explanations', () => {
  const store = createSampleTreeStore()
  const byMessage = nodesByMessage(store)
  const greeting = byMessage.get('say hey to the other lanes and report who answers')
  const summary = byMessage.get('collect the acknowledgements and post one summary')
  const running = byMessage.get('what tools do you have access to on the computer you are driving')
  const draft = byMessage.get('list only the ones that can write, and say what each may touch')
  const blocked = byMessage.get('can you open chrome and take a screenshot of the dashboard')

  assert.equal(byMessage.size, 5, 'the sample must expose every seeded agent to the graph')
  assert.equal(summary?.parentId, greeting?.id,
    'the acknowledgement collector must be a child of the greeting coordinator')
  assert.equal(greeting?.status, 'finished', 'the greeting coordinator must read as completed work')
  assert.equal(running?.status, 'running', 'the tools enquiry must demonstrate live work')
  assert.match(running?.sessionId || '', /^sample-session-/,
    'a running sample agent must carry an explicitly sample-only session identity')
  assert.equal(draft?.status, 'draft', 'the write-capable-tools follow-up must demonstrate unstarted work')
  assert.equal(blocked?.status, 'failed', 'the browser request must demonstrate a failed start')
  assert.match(blocked?.statusNote || '', /blocked.+environment policy/i,
    'the failed browser request must explain that the environment policy blocked it')

  const refusal = store.removeNode(running.id)
  assert.equal(refusal.ok, false, 'a running sample agent must not be removable')
  assert.match(refusal.problems.join(' '), /stop.+first/i,
    'the removal refusal must tell the user to stop the running agent first')
})

test('stores are ephemeral, independent, and forward live snapshots to the caller', () => {
  const changes = []
  const first = createSampleTreeStore({ onChange: snapshot => changes.push(snapshot) })
  const second = createSampleTreeStore()
  const firstTree = first.listTrees()[0]
  const originalSecondLabel = second.treeLabel(second.listTrees()[0].id)

  assert.ok(changes.length > 0, 'onChange must observe the construction of the sample store')
  assert.equal(changes.at(-1)?.nodes.length, 5,
    'the final construction callback must describe the complete sample, not a partial seed')
  assert.equal(first.renameTree(firstTree.id, 'a temporary example edit').ok, true,
    'the example store must support the same live edits as a real tree store')
  assert.equal(second.treeLabel(second.listTrees()[0].id), originalSecondLabel,
    'an edit in one sample store must not persist into a newly opened sample store')
  assert.equal(changes.at(-1)?.trees[0]?.name, 'a temporary example edit',
    'onChange must receive the snapshot produced by a live example edit')
})

test('a caller failure while constructing the store is surfaced, not mistaken for a built sample', () => {
  const couldNotRead = new Error('caller could not accept the tree snapshot')
  assert.throws(
    () => createSampleTreeStore({ onChange: () => { throw couldNotRead } }),
    error => error === couldNotRead,
    'a construction callback failure must escape so the view can report that the example could not be built',
  )
})
