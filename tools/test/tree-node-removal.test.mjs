import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { planNodeRemoval, runNodeRemoval, branchRemovalConfirmation } from '../../src/tree-node-removal.js'
import { createSingleFlight } from '../../src/single-flight.js'

function fixture() {
  const cells = new Map()
  let counter = 0, tick = 0
  const store = createFleetTreeStore({ computerId: 'cascade-test',
    storage: { read: key => cells.has(key) ? structuredClone(cells.get(key)) : null,
      write: (key, value) => { cells.set(key, structuredClone(value)); return true } },
    now: () => new Date(Date.UTC(2026, 8, 8, 0, 0, tick++)).toISOString(), makeId: kind => `${kind}-${++counter}`,
  })
  const add = (name, parentId) => {
    const result = store.addNode({ name, role: name, ...(parentId ? { parentId } : {}) })
    assert.equal(result.ok, true, result.problems?.join(', '))
    return result.node
  }
  const root = add('Controller'), manager = add('Manager', root.id), sibling = add('Sibling', root.id)
  const first = add('First', manager.id), second = add('Second', manager.id), nested = add('Nested', first.id)
  return { store, add, root, manager, sibling, first, second, nested, cells }
}

test('preview counts the complete branch; dismissing it leaves nodes and persistence untouched', () => {
  const { store, manager, cells } = fixture()
  const before = JSON.stringify(store.snapshot()), saved = JSON.stringify([...cells])
  const plan = planNodeRemoval(store, manager.id)
  assert.equal(plan.ok, true)
  assert.equal(plan.count, 4)
  assert.match(branchRemovalConfirmation('Manager', plan.count), /Manager and all 3 agents below it \(4 agents total\)/)
  assert.match(branchRemovalConfirmation('Manager', plan.count), /saved conversations.*signed run records are kept/)
  // The popup's Back/close cancels by never invoking the confirmed runner.
  assert.equal(JSON.stringify(store.snapshot()), before)
  assert.equal(JSON.stringify([...cells]), saved)
})

test('a confirmed branch uses the real leaf-only store in child-first order and preserves siblings', async () => {
  const { store, manager, root, sibling, first, second, nested } = fixture()
  store.attachSession(first.id, 'finished-session')
  store.setNodeStatus(first.id, 'finished')
  store.attachSession(second.id, 'failed-session')
  store.setNodeStatus(second.id, 'failed')
  const originalSibling = store.getNode(sibling.id), originalRoot = store.getNode(root.id)
  const removed = []
  const result = await runNodeRemoval(planNodeRemoval(store, manager.id), {
    store, remove: async (node, stillCurrent) => {
      assert.equal(stillCurrent(), true)
      assert.deepEqual(store.childrenOf(node.id), [], 'every owned removal receives an actual leaf')
      removed.push(node.id)
      return store.removeNode(node.id)
    },
  })
  assert.equal(result.ok, true, result.problems.join(', '))
  assert.deepEqual(removed, [nested.id, first.id, second.id, manager.id])
  assert.deepEqual(result.removed, removed)
  assert.deepEqual(result.kept, [])
  assert.deepEqual(store.getNode(root.id), originalRoot)
  assert.deepEqual(store.getNode(sibling.id), originalSibling)
  assert.equal(store.listNodes(root.treeId).length, 2)
})

test('one live or starting descendant refuses the whole branch before any sibling is removed', async () => {
  for (const status of ['starting', 'running']) {
    const { store, manager, second } = fixture()
    store.attachSession(second.id, `session-${status}`)
    if (status === 'running') store.setNodeStatus(second.id, status)
    const plan = planNodeRemoval(store, manager.id)
    assert.equal(plan.ok, false)
    let calls = 0
    const result = await runNodeRemoval(plan, { store, remove: () => { calls++; return true } })
    assert.equal(result.ok, false)
    assert.equal(calls, 0)
    assert.deepEqual(result.removed, [])
  }
})

test('a start/replacement flight without a session also refuses all removals', async () => {
  const { store, manager, nested } = fixture()
  const blocked = node => node.id === nested.id ? 'This agent is still starting.' : null
  const plan = planNodeRemoval(store, manager.id, { blocked })
  assert.equal(plan.ok, false)
  const result = await runNodeRemoval(plan, { store, blocked, remove: () => assert.fail('a blocked plan must not remove') })
  assert.match(result.problems[0], /starting/)
})

test('an added descendant while confirmation is open is never silently included', async () => {
  const { store, add, manager } = fixture()
  const plan = planNodeRemoval(store, manager.id)
  const newcomer = add('Newcomer', manager.id)
  const result = await runNodeRemoval(plan, { store, remove: () => assert.fail('stale preview removed an agent') })
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /changed after the removal preview/)
  assert.ok(store.getNode(newcomer.id))
  assert.deepEqual(result.removed, [])
})

test('a sibling becoming active during an async archive prevents even the current leaf from being deleted', async () => {
  const { store, manager, second } = fixture()
  const plan = planNodeRemoval(store, manager.id)
  let calls = 0
  const result = await runNodeRemoval(plan, { store, remove: async (node, stillCurrent) => {
    calls++
    await Promise.resolve()
    store.attachSession(second.id, 'new-session')
    assert.equal(stillCurrent(), false, 'the post-archive guard covers every remaining agent')
    return { ok: false, problems: ['The branch changed while archiving.'] }
  } })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.deepEqual(result.removed, [])
  assert.equal(result.kept.length, 4)
})

test('concurrent reparenting stops remaining removals and reports the exact completed part', async () => {
  const { store, manager, first, second, nested, root } = fixture()
  const plan = planNodeRemoval(store, manager.id)
  let calls = 0
  const result = await runNodeRemoval(plan, { store, remove: async node => {
    calls++
    const outcome = store.removeNode(node.id)
    assert.equal(outcome.ok, true)
    assert.equal(store.moveNode(second.id, root.id).ok, true)
    return outcome
  } })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.deepEqual(result.removed, [nested.id])
  assert.deepEqual(new Set(result.kept), new Set([first.id, second.id, manager.id]))
  assert.ok(store.getNode(second.id), 'the moved agent is kept')
  assert.ok(store.getNode(manager.id), 'the remaining branch is kept')
})

test('a close/archive refusal stops at that leaf and keeps a clear partial result', async () => {
  const { store, manager, nested } = fixture()
  let calls = 0
  const result = await runNodeRemoval(planNodeRemoval(store, manager.id), { store, remove: async node => {
    if (++calls === 2) return { ok: false, problems: ['The conversation could not be archived.'] }
    return store.removeNode(node.id)
  } })
  assert.equal(calls, 2)
  assert.equal(result.ok, false)
  assert.deepEqual(result.removed, [nested.id])
  assert.equal(result.kept.length, 3)
  assert.match(result.problems[0], /could not be archived/)
})

test('changing the active store after preview refuses before touching either computer', async () => {
  const { store, manager } = fixture()
  const result = await runNodeRemoval(planNodeRemoval(store, manager.id), { store, isCurrent: () => false,
    remove: () => assert.fail('inactive computer was touched') })
  assert.equal(result.ok, false)
  assert.deepEqual(result.removed, [])
})

test('a cleanup exception after a successful store removal still reports that agent as removed', async () => {
  const { store, manager, nested } = fixture()
  const result = await runNodeRemoval(planNodeRemoval(store, manager.id), { store, remove: async node => {
    assert.equal(store.removeNode(node.id).ok, true)
    throw new Error('A post-removal cleanup failed.')
  } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.removed, [nested.id])
  assert.equal(result.kept.length, 3)
})

test('the view guards repeated confirmation with a flight and keeps agent-command removal leaf-only', async () => {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  assert.match(source, /nodeBranchRemovalFlight\.run\(plan\.rootId/)
  assert.match(source, /removeCircle: performNodeRemoval/)
  assert.doesNotMatch(source, /removeCircle: performNodeBranchRemoval/)
  assert.match(source, /&& \(!branchGuard \|\| branchGuard\(\)\)/, 'the existing close/archive freshness guard also checks the full branch')
  const flight = createSingleFlight()
  let finish, calls = 0
  const first = flight.run('manager', async () => { calls++; await new Promise(resolve => { finish = resolve }); return true })
  const second = await flight.run('manager', () => { calls++; return true })
  assert.equal(second.ran, false)
  assert.equal(calls, 1)
  finish()
  assert.deepEqual(await first, { ran: true, value: true })
})
