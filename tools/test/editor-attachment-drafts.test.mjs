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

/* D8 (1.0.48): THE COPY RUNS THE EDITOR'S OWN MODEL, OR IT IS REFUSED. Claude
   Code records the raw model id (`claude-opus-5-5`, or the dated
   `claude-haiku-4-5-20251001`), which never equals a row's `claude/...` model.
   The lookup fell to the provider's first row, so an Opus 5.5 conversation was
   copied onto Fable without a word. It now matches the row's CLI name too, and
   a model no row runs is refused rather than swapped. */
test('an editor copy lands on the row that runs its model, matched by CLI name', async () => {
  const { LAUNCH_TIERS } = await import('../../src/orchestration-controls.js')
  const claude = { ...prepared, provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }
  for (const [model, tier, effort] of [['claude-opus-5-5', 'claude-opus-5-5', 'xhigh'], ['claude-sonnet-5', 'claude-sonnet-5', 'xhigh'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', '']]) {
    const { store, coordinator } = fixture(), tree = store()
    assert.equal(coordinator.queue({ ...claude, model }).ok, true)
    const installed = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers: LAUNCH_TIERS })
    assert.equal(installed.ok, true, model)
    assert.equal(installed.node.tier, tier, `${model} was copied onto ${installed.node.tier}`)
    assert.equal(installed.node.effort, effort, `${model}: only a depth that model takes is kept`)
  }
})

test('an editor copy whose model no row runs is refused instead of falling to another model', async () => {
  const { LAUNCH_TIERS } = await import('../../src/orchestration-controls.js')
  for (const model of ['claude-mythos-5']) {
    const { store, coordinator } = fixture(), tree = store()
    coordinator.queue({ ...prepared, provider: 'claude', model })
    const refused = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers: LAUNCH_TIERS })
    assert.equal(refused.ok, false, `${model}: a copy on an unknown model was installed`)
    assert.equal(refused.code, 'EDITOR_FORK_MODEL_UNAVAILABLE')
    assert.match(refused.reason, /start a fresh agent/)
    assert.equal(tree.snapshot().nodes.length, 0, 'no draft is left behind on a model nobody chose')
  }
})

/* REVIEW P17. The editor source reports model null when no model id was
   observed in the window it scanned. That copy was refused as a model this
   app does not offer, "Update ToolsEnabled" -- advice that cannot help. It
   gets its own sentence: the model could not be read yet, and what to do. */
test('an editor copy whose model was not read yet says so, not "update ToolsEnabled"', async () => {
  const { LAUNCH_TIERS } = await import('../../src/orchestration-controls.js')
  const { findingsInText } = await import('../check-plain-language.mjs')
  for (const model of [null, '', '   ']) {
    const { store, coordinator } = fixture(), tree = store()
    coordinator.queue({ ...prepared, provider: 'claude', model })
    const refused = coordinator.install(tree, { computerId: 'computer-a', local: true, tiers: LAUNCH_TIERS })
    assert.equal(refused.ok, false, `${JSON.stringify(model)}: a copy with no model was installed`)
    assert.equal(refused.code, 'EDITOR_FORK_MODEL_UNREAD', `${JSON.stringify(model)} was refused as ${refused.code}`)
    assert.doesNotMatch(refused.reason, /Update ToolsEnabled|does not offer/)
    assert.match(refused.reason, /could not be read yet/)
    assert.match(refused.reason, /check for sessions again/)
    assert.deepEqual(findingsInText(refused.reason), [], 'the sentence passes the plain-language rules')
    assert.equal(tree.snapshot().nodes.length, 0)
  }
})
