import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationNavigationStore } from '../../src/tree-conversation-navigation.js'

test('tabs retain independent computer selections while deleted and recreated nodes are excluded', () => {
  const store = createConversationNavigationStore()
  const nodes = new Map([['busy', { createdAt: 1 }], ['stopped', { createdAt: 2 }]])
  const tabs = [{ id: 'busy', createdAt: 1 }, { id: 'stopped', createdAt: 2 }]
  store.save('one', { tabs, activeId: 'busy', mode: 'chat' })
  store.save('two', { tabs: [tabs[1]], activeId: 'stopped', mode: 'chat' })
  assert.deepEqual(store.take('one', id => nodes.get(id)), { tabs: tabs.map(t => ({ ...t, standalone: false })), activeId: 'busy', mode: 'chat' })
  assert.equal(store.take('one', id => nodes.get(id)), null, 'a handoff is consumed once')
  nodes.set('stopped', { createdAt: 3 })
  assert.deepEqual(store.take('two', id => nodes.get(id)), { tabs: [], activeId: null, mode: 'trees' })
  store.save('one', { tabs, activeId: 'busy', mode: 'chat' }); nodes.delete('busy')
  assert.deepEqual(store.take('one', id => nodes.get(id)), { tabs: [], activeId: null, mode: 'trees' })
})

test('explicit close and the Trees selection replace earlier navigation state', () => {
  const store = createConversationNavigationStore(), node = { createdAt: 1 }
  store.save('one', { tabs: [{ id: 'a', createdAt: 1 }], activeId: 'a', mode: 'chat' })
  store.save('one', { tabs: [], activeId: null, mode: 'trees' })
  assert.deepEqual(store.take('one', () => node), { tabs: [], activeId: null, mode: 'trees' })
  store.save('one', { tabs: [{ id: 'a', createdAt: 1 }], activeId: 'a', mode: 'trees' })
  assert.equal(store.take('one', () => node).mode, 'trees')
})
