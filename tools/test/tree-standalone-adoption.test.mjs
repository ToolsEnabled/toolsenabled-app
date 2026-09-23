import test from 'node:test'
import assert from 'node:assert/strict'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { adoptStandaloneIntoTree } from '../../src/tree-standalone-adoption.js'

function setup({ running = true, write = true } = {}) {
  let saved = null
  const store = createFleetTreeStore({ computerId: 'adoption-test', storage: {
    read: () => saved, write: (_key, value) => { if (write) saved = value; return write },
  } })
  const original = { sessionId: running ? 'existing-session' : null, phase: running ? 'working' : 'draft',
    prompt: 'Keep working on the existing task.', transcript: [{ who: 'you', text: 'Original task', at: 100 }], currentText: 'Partial answer', turnId: 'turn-a' }
  const calls = [], binding = {}, panel = {}, draft = { text: 'Unsent follow-up', attachments: ['kept.png'] }
  let pending = false
  const session = {
    panel, draft,
    snapshot: () => structuredClone(original),
    beginPlacement() { if (pending || binding.nodeId) return { ok: false }; pending = true; calls.push('begin'); return { ok: true, snapshot: this.snapshot() } },
    cancelPlacement() { pending = false; calls.push('cancel') },
    commitPlacement(next) { Object.assign(binding, next); pending = false; calls.push('commit'); return this.snapshot() },
    /* T300: the seat lets go of the durable record before the tree claims the
       session, because the capture refuses to repoint a live binding. Recorded
       in call order so a test can say it happened BEFORE the adopt, which is
       the only ordering that works. */
    async releaseTranscript(sessionId) { calls.push(['release', sessionId]); return { ok: true, released: true } },
  }
  const bridge = { async adoptTreeAddress(request) { calls.push(['adopt', request]); return { ok: true, sessionId: request.sessionId, nodeId: request.requestKeys.threadId, treeKey: request.treeKey } } }
  const args = { store, session, bridge,
    identityFor: node => ({ treeKey: node.parentId || node.id, selfName: 'Agent', managerName: node.parentId ? 'Parent' : null,
      requestKeys: { treeAnchors: node.parentId ? [node.parentId, node.id] : [node.id], threadId: node.id } }),
    bindSession(node, host, snapshot) { calls.push(['bind', node.id, host, snapshot]); return { getStartOptions: () => ({ nodeId: node.id }) } },
    reveal: node => calls.push(['reveal', node.id]),
  }
  return { store, session, original, calls, binding, args, panel, draft }
}

test('a running standalone becomes its own real tree without any start, send or close', async () => {
  const h = setup(), result = await adoptStandaloneIntoTree(h.args)
  assert.equal(result.ok, true)
  assert.equal(h.store.listTrees().length, 1)
  const node = h.store.getNode(result.nodeId)
  assert.equal(node.parentId, null)
  assert.equal(node.sessionId, 'existing-session')
  assert.equal(h.binding.nodeId, node.id)
  assert.equal(h.session.panel, h.panel); assert.equal(h.session.draft, h.draft)
  assert.deepEqual(h.calls.filter(Array.isArray).map(call => call[0]), ['release', 'adopt', 'bind', 'reveal'],
    'the seat releases its transcript binding BEFORE the tree claims the session, or the capture refuses the tree binding')
  assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'adopt')[1].requestKeys.treeAnchors, [node.id])
})

test('joining a parent keeps the existing tree and has one authenticated node address', async () => {
  const h = setup(), parent = h.store.addNode({ role: 'manager' }).node
  const result = await adoptStandaloneIntoTree({ ...h.args, parentId: parent.id })
  const node = h.store.getNode(result.nodeId)
  assert.equal(result.ok, true); assert.equal(node.parentId, parent.id); assert.equal(node.treeId, parent.treeId)
  assert.equal(h.store.listTrees().length, 1)
  assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'adopt')[1].requestKeys.treeAnchors, [parent.id, node.id])
})

test('an untouched draft becomes a tree draft and retains its composer without contacting the host', async () => {
  const h = setup({ running: false }), result = await adoptStandaloneIntoTree(h.args)
  assert.equal(result.ok, true)
  assert.equal(h.store.getNode(result.nodeId).status, 'draft')
  assert.equal(h.store.getNode(result.nodeId).sessionId, null)
  assert.equal(h.calls.some(call => call[0] === 'adopt'), false)
  assert.equal(h.session.draft, h.draft)
  assert.deepEqual(h.binding.getStartOptions(), { nodeId: result.nodeId })
})

test('host refusal removes only the new reservation and leaves the running tab usable', async () => {
  const h = setup(), parent = h.store.addNode({ message: 'Existing parent' }).node
  const before = h.store.snapshot().nodes
  h.args.bridge.adoptTreeAddress = async () => ({ ok: false, sentence: 'The session has ended.' })
  const result = await adoptStandaloneIntoTree({ ...h.args, parentId: parent.id })
  assert.equal(result.ok, false); assert.equal(result.sentence, 'The session has ended.')
  assert.deepEqual(h.store.snapshot().nodes, before)
  assert.equal(h.calls.at(-1), 'cancel'); assert.equal(h.binding.nodeId, undefined)
  assert.equal(h.session.draft, h.draft)
  assert.equal(h.session.beginPlacement().ok, true, 'a retry is possible')
})

test('a rejected IPC rolls back its empty tree as well as its node', async () => {
  const h = setup(); h.args.bridge.adoptTreeAddress = async () => { throw new Error('host refused') }
  assert.equal((await adoptStandaloneIntoTree(h.args)).ok, false)
  assert.equal(h.store.listTrees().length, 0); assert.equal(h.store.snapshot().nodes.length, 0)
  assert.equal(h.calls.at(-1), 'cancel')
})

test('while IPC waits, the actual reserved session is protected from leaf removal and duplicate placement', async () => {
  const h = setup(); let finish
  h.args.bridge.adoptTreeAddress = () => new Promise(resolve => { finish = resolve })
  const first = adoptStandaloneIntoTree(h.args)
  const node = h.store.snapshot().nodes[0]
  assert.equal(node.sessionId, h.original.sessionId)
  assert.equal(h.store.removeNode(node.id).ok, false)
  assert.equal((await adoptStandaloneIntoTree(h.args)).ok, false)
  assert.equal(h.store.snapshot().nodes.length, 1)
  finish({ ok: true, sessionId: node.sessionId, nodeId: node.id, treeKey: node.id }); assert.equal((await first).ok, true)
})

test('host acceptance transfers custody before renderer binding can fail', async () => {
  const h = setup(); h.args.bindSession = () => { throw new Error('retired view') }
  const result = await adoptStandaloneIntoTree(h.args)
  assert.equal(result.ok, true)
  assert.equal(h.binding.nodeId, result.nodeId, 'tab teardown already knows to retain the tree session')
  assert.equal(h.store.getNode(result.nodeId).sessionId, h.original.sessionId)
  assert.equal(h.calls.includes('cancel'), false)
})

test('invalid parent, duplicate held session, absent host and save failure never assign a host address', async () => {
  for (const kind of ['parent', 'duplicate', 'host', 'save']) {
    const h = setup({ write: kind !== 'save' })
    if (kind === 'parent') h.args.parentId = 'gone'
    if (kind === 'duplicate') { const node = h.store.addNode().node; h.store.attachSession(node.id, h.original.sessionId) }
    if (kind === 'host') h.args.bridge = {}
    assert.equal((await adoptStandaloneIntoTree(h.args)).ok, false, kind)
    assert.equal(h.calls.some(call => call[0] === 'adopt'), false, kind)
    assert.equal(h.binding.nodeId, undefined, kind)
    assert.equal(h.calls.at(-1), 'cancel', kind)
  }
})


/* T300, the ordering on its own so it cannot be lost in a longer assertion.
   The capture (shell/node-transcript-capture.cjs) throws "Session already
   belongs to another transcript node" when a live binding is repointed, and
   agent-command-surface swallows that throw in a catch -- so getting this
   order wrong is silent: adoption still reports success and the conversation
   keeps writing to the seat while the tree believes it owns it. */
test('the seat releases its transcript binding before adoptTreeAddress, for the session being adopted', async () => {
  const h = setup()
  const result = await adoptStandaloneIntoTree(h.args)
  assert.equal(result.ok, true)
  const order = h.calls.filter(Array.isArray)
  const release = order.findIndex(call => call[0] === 'release')
  const adopt = order.findIndex(call => call[0] === 'adopt')
  assert.notEqual(release, -1, 'the seat binding is released')
  assert.ok(release < adopt, 'and released before the tree address is adopted')
  assert.equal(order[release][1], 'existing-session', 'the released session is the one being handed over')
})

/* A draft that was never started holds no binding, so there is nothing to
   release and nothing to say -- and no host call is made at all. */
test('adopting an unstarted draft releases no transcript binding', async () => {
  const h = setup({ running: false })
  const result = await adoptStandaloneIntoTree(h.args)
  assert.equal(result.ok, true)
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'release'), false)
})

/* T1491 at the unit: the brief is the prompt that was SENT. A snapshot's
   `prompt` falls back to the composer's unsent text; `sentPrompt` does not. */
test('only a sent prompt becomes the placed circle brief; unsent composer words never do', async () => {
  const unsent = setup({ running: false })
  unsent.args.session.snapshot = () => ({ sessionId: null, phase: 'draft', prompt: 'typed, never sent', sentPrompt: '', transcript: [], currentText: '' })
  const a = await adoptStandaloneIntoTree(unsent.args)
  assert.equal(unsent.store.getNode(a.nodeId).message, '')

  const older = setup({ running: false })
  older.args.session.snapshot = () => ({ sessionId: null, phase: 'draft', prompt: 'typed, never sent', transcript: [], currentText: '' })
  const b = await adoptStandaloneIntoTree(older.args)
  assert.equal(older.store.getNode(b.nodeId).message, '', 'a never-sent draft phase carries no brief even without sentPrompt')

  const sent = setup()
  sent.args.session.snapshot = () => ({ ...structuredClone(sent.original), prompt: 'Keep working on the existing task.', sentPrompt: 'Keep working on the existing task.' })
  const c = await adoptStandaloneIntoTree(sent.args)
  assert.equal(sent.store.getNode(c.nodeId).message, 'Keep working on the existing task.', 'what was sent stays the brief')
  assert.equal(sent.store.getNode(c.nodeId).role, 'worker', 'the circle takes the Worker identity the tab was declared with')
})
