import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorAttachmentDrafts, normalizePendingEditorFork } from '../../src/editor-attachment-drafts.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'

const prepared = { ok: true, forkReceipt: 'a'.repeat(43), expiresAt: 1000, provider: 'codex',
  sourceSessionId: '11111111-2222-3333-4444-555555555555', workspace: 'work', model: 'gpt-test', effort: 'ultra', historyScope: 'current-model-context' }
const tiers = [{ id: 'chosen', model: 'gpt-test', provider: 'codex' }]
function fixture() {
  const data = new Map()
  const storage = { read: key => data.has(key) ? JSON.parse(data.get(key)) : null,
    write: (key, value) => { data.set(key, JSON.stringify(value)); return true } }
  let id = 0
  const store = () => createFleetTreeStore({ computerId: 'computer-a', storage, makeId: kind => `${kind}-${++id}` })
  return { data, store, coordinator: createEditorAttachmentDrafts({ now: () => 100 }) }
}

test('preparing a copy creates a durable draft; its receipt is never persisted', () => {
  const { data, store, coordinator } = fixture(), tree = store()
  assert.equal(coordinator.queue(prepared).ok, true)
  const installed = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers })
  assert.equal(installed.ok, true)
  assert.equal(installed.node.status, 'draft')
  assert.equal(installed.node.sessionId, null)
  assert.equal(installed.node.tier, 'chosen')
  assert.equal(installed.node.effort, 'ultra')
  assert.equal(installed.node.pendingEditorFork.sourceSessionId, prepared.sourceSessionId)
  assert.equal(installed.node.pendingEditorFork.historyScope, 'current-model-context')
  assert.equal(coordinator.forNode(installed.node, 'computer-a').receipt, prepared.forkReceipt)
  assert.equal([...data.values()].join('').includes(prepared.forkReceipt), false)
  const reloaded = store().getNode(installed.node.id)
  assert.equal(reloaded.pendingEditorFork.historyScope, 'current-model-context')
  assert.equal(reloaded.effort, 'ultra')
  const newWindow = createEditorAttachmentDrafts({ now: () => 100 })
  assert.equal(newWindow.forNode(reloaded, 'computer-a').code, 'EDITOR_RECEIPT_UNAVAILABLE')
})

test('selecting the source again refreshes the existing draft without adding another tree', () => {
  const { store, coordinator } = fixture(), tree = store()
  coordinator.queue(prepared)
  const first = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers })
  coordinator.queue({ ...prepared, forkReceipt: 'b'.repeat(43) })
  const second = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers })
  assert.equal(second.node.id, first.node.id)
  assert.equal(tree.snapshot().nodes.length, 1)
  assert.equal(coordinator.forNode(second.node, 'computer-a').receipt, 'b'.repeat(43))
  tree.attachSession(second.node.id, 'copy-session')
  assert.equal(tree.getNode(second.node.id).pendingEditorFork, null)
})

test('example or remote trees cannot consume a local editor choice', () => {
  const { store, coordinator } = fixture(), tree = store()
  coordinator.queue(prepared)
  assert.equal(coordinator.install(tree, { computerId: 'computer-a', local: false, tiers }).code, 'EDITOR_FORK_LOCAL_ONLY')
  assert.equal(tree.snapshot().nodes.length, 0)
  assert.equal(coordinator.install(tree, { computerId: 'computer-a', local: true, tiers }).ok, true)
})

test('damaged source markers remain visible as unavailable instead of becoming fresh starts', () => {
  assert.deepEqual(normalizePendingEditorFork({ provider: 'other' }), { invalid: true })
  const { store, coordinator } = fixture(), tree = store()
  const bad = tree.addNode({ pendingEditorFork: { provider: 'other' } })
  assert.equal(bad.ok, false)
  assert.equal(coordinator.forNode({ id: 'a', pendingEditorFork: { invalid: true } }, 'computer-a').ok, false)
})

test('a copied context keeps its chosen role and continuing request when joined under a controller', () => {
  const { store, coordinator } = fixture(), tree = store()
  const controller = tree.addNode({ role: 'controller', tier: 'chosen', message: 'Oversee the four restored contexts.' }).node
  const message = 'Continue the release work from the saved context and report current evidence to Controller.'
  coordinator.queue({ ...prepared, role: 'release-manager', message })
  const installed = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers })
  assert.equal(installed.node.role, 'release-manager')
  assert.equal(installed.node.message, message)
  const moved = tree.moveNode(installed.node.id, controller.id)
  assert.equal(moved.ok, true)
  assert.equal(moved.node.treeId, controller.treeId)
  assert.equal(moved.node.parentId, controller.id)
  assert.equal(moved.node.message, message)
  assert.equal(moved.node.pendingEditorFork.sourceSessionId, prepared.sourceSessionId)
  assert.equal(coordinator.forNode(moved.node, 'computer-a').receipt, prepared.forkReceipt)
  assert.equal(tree.listTrees().length, 1)
})
