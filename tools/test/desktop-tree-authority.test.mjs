import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  createDesktopTreeViewStore,
  desktopTreeBridge,
  desktopTreeComputer,
  readDesktopTreeAnswer,
  readDesktopTreeSnapshot,
} from '../../src/desktop-tree-authority.js'

const fixture = {
  ok: true,
  mayWrite: false,
  desktopTree: {
    version: 1,
    computerId: 'this-computer',
    trees: [
      { id: 'tree-a', name: 'Saved work', createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' },
      { id: 'tree-empty', name: 'Empty tree', createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' },
    ],
    nodes: [
      { id: 'root-a', treeId: 'tree-a', parentId: null, role: 'controller', name: 'Controller', status: 'finished', message: 'Root task', reply: 'done' },
      { id: 'child-a', treeId: 'tree-a', parentId: 'root-a', role: 'worker', name: 'Worker', status: 'running', sessionId: 'session-a', message: 'Child task' },
      { id: 'draft-a', treeId: 'tree-a', parentId: 'child-a', role: 'worker', status: 'draft', message: 'Draft task' },
    ],
  },
  sessions: [{ sessionId: 'session-a', nodeId: 'child-a', busy: false, turnsCompleted: 2 }],
  sessionsTruncated: false,
}

test('ordinary native snapshot preserves tree identity, empty trees, hierarchy and separate idle activity', () => {
  const snapshot = readDesktopTreeAnswer(fixture)
  assert.equal(snapshot.source, 'native-desktop-tree')
  assert.deepEqual(snapshot.trees.map(tree => tree.id), ['tree-a', 'tree-empty'])
  assert.deepEqual(snapshot.nodes.map(node => [node.id, node.treeId, node.parentId, node.status]), [
    ['root-a', 'tree-a', null, 'finished'],
    ['child-a', 'tree-a', 'root-a', 'running'],
    ['draft-a', 'tree-a', 'child-a', 'draft'],
  ])
  assert.equal(snapshot.sessions[0].busy, false)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.nodes[0]), true)
})

test('native prompts preserve ordinary line breaks and tabs while refusing hidden controls', () => {
  const multiline = readDesktopTreeAnswer({
    ...fixture,
    desktopTree: { ...fixture.desktopTree, nodes: fixture.desktopTree.nodes.map((node, index) => index === 0 ? { ...node, message: 'first line\nsecond\tline' } : node) },
  })
  assert.equal(multiline.nodes[0].message, 'first line\nsecond\tline')
  assert.throws(() => readDesktopTreeAnswer({
    ...fixture,
    desktopTree: { ...fixture.desktopTree, nodes: fixture.desktopTree.nodes.map((node, index) => index === 0 ? { ...node, message: 'bad\u0000prompt' } : node) },
  }), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
})

test('invalid topology refuses instead of becoming an empty or reconstructed tree', () => {
  assert.throws(() => readDesktopTreeAnswer({ ...fixture, desktopTree: { ...fixture.desktopTree, nodes: [{ ...fixture.desktopTree.nodes[1], parentId: 'foreign' }] } }), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
  assert.throws(() => readDesktopTreeAnswer({ ...fixture, desktopTree: { ...fixture.desktopTree, nodes: [{ ...fixture.desktopTree.nodes[0], id: 'tree-a' }] } }), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
  assert.throws(() => readDesktopTreeAnswer({ ok: false, code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' }), { code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' })
})

test('lossless pages are assembled and hashed before parsing', async () => {
  const payload = new TextEncoder().encode(JSON.stringify(fixture))
  const digest = createHash('sha256').update(payload).digest('hex')
  const chunkBytes = 64 * 1024
  const pages = Math.ceil(payload.length / chunkBytes)
  const bridge = {
    async read(request) {
      if (!request) throw Object.assign(new Error('too large'), { code: 'AGENT_FACADE_RESPONSE_TOO_LARGE' })
      const page = request.page
      return { desktopTreeSnapshot: {
        version: 1, sha256: digest, bytes: payload.length, page, pages,
        data: Buffer.from(payload.subarray(page * chunkBytes, Math.min(payload.length, (page + 1) * chunkBytes))).toString('base64'),
      } }
    },
  }
  const snapshot = await readDesktopTreeSnapshot(bridge)
  assert.equal(snapshot.nodes[2].status, 'draft')
  assert.deepEqual(snapshot.trees.map(tree => tree.id), ['tree-a', 'tree-empty'])
})

test('projection carries exact native ids and parent edges without making busy imply saved running status', () => {
  const computer = desktopTreeComputer(readDesktopTreeAnswer(fixture))
  assert.equal(computer.authoritative, true)
  assert.deepEqual(computer.trees.map(tree => [tree.id, tree.rootId, tree.count]), [
    ['tree-a', 'root-a', 3], ['tree-empty', null, 0],
  ])
  assert.deepEqual(computer.graphEdges, [{ from: 'root-a', to: 'child-a', type: 'manages', sourceKind: 'observed' }, { from: 'child-a', to: 'draft-a', type: 'manages', sourceKind: 'observed' }])
  assert.equal(computer.agents.find(node => node.id === 'child-a').busy, false)
})


test('native Research badges inherit only the validated project on each node tree', () => {
  const snapshot = readDesktopTreeAnswer({
    ...fixture,
    desktopTree: {
      ...fixture.desktopTree,
      trees: fixture.desktopTree.trees.map(tree => tree.id === 'tree-a'
        ? { ...tree, researchProjectId: 'rp-a111', researchProjectName: 'Lean Bench' } : tree),
      nodes: [
        ...fixture.desktopTree.nodes.map(node => ({ ...node, researchProjectId: 'rp-b222', researchProjectName: 'Ignored node field' })),
        { id: 'ordinary-root', treeId: 'tree-empty', parentId: null, status: 'draft', researchProjectId: 'rp-b222' },
      ],
    },
  })
  const computer = desktopTreeComputer(snapshot)
  for (const id of ['root-a', 'child-a', 'draft-a']) {
    const agent = computer.agents.find(node => node.id === id)
    assert.equal(agent.researchProjectId, 'rp-a111', id)
    assert.equal(agent.researchProjectName, 'Lean Bench', id)
  }
  const ordinary = computer.agents.find(node => node.id === 'ordinary-root')
  assert.equal(Object.hasOwn(ordinary, 'researchProjectId'), false)
  assert.equal(Object.hasOwn(ordinary, 'researchProjectName'), false)
  assert.equal(computer.agents.find(node => node.id === 'child-a').role, 'worker')
})

test('native Research metadata is validated and absence never creates a badge', () => {
  for (const fields of [
    { researchProjectId: 'rp-nope' },
    { researchProjectId: 'rp-a' },
    { researchProjectId: 42 },
    { researchProjectId: 'rp-a111', researchProjectName: 'x'.repeat(121) },
    { researchProjectId: 'rp-a111', researchProjectName: 'bad\u0000name' },
  ]) {
    assert.throws(() => readDesktopTreeAnswer({
      ...fixture,
      desktopTree: { ...fixture.desktopTree, trees: fixture.desktopTree.trees.map((tree, index) => index === 0 ? { ...tree, ...fields } : tree) },
    }), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
  }
  const snapshot = readDesktopTreeAnswer(fixture)
  for (const agent of desktopTreeComputer(snapshot).agents) assert.equal(Object.hasOwn(agent, 'researchProjectId'), false)
  const malformedProjection = { ...snapshot, trees: snapshot.trees.map(tree => ({ ...tree, researchProjectId: 'not-a-project' })) }
  for (const agent of desktopTreeComputer(malformedProjection).agents) assert.equal(Object.hasOwn(agent, 'researchProjectId'), false)
})

test('native tree facade reads its project binding but refuses changing it', () => {
  const snapshot = readDesktopTreeAnswer({
    ...fixture,
    desktopTree: { ...fixture.desktopTree, trees: fixture.desktopTree.trees.map(tree => ({ ...tree,
      researchProjectId: 'rp-a111', researchProjectName: 'Lean Bench' })) },
  })
  const store = createDesktopTreeViewStore(snapshot)
  assert.equal(store.getTree('tree-a'), snapshot.trees[0])
  assert.equal(store.getTree('missing'), null)
  const before = store.snapshot()
  for (const projectId of ['rp-b222', null]) {
    const result = store.setTreeResearchProject('tree-a', projectId, 'Other')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MC_AGENT_DESKTOP_TREE_READ_ONLY')
    assert.deepEqual(store.snapshot(), before)
  }
  assert.equal(Object.isFrozen(store.getTree('tree-a')), true)
})

test('bridge discovery uses the dedicated authority seam and has no fallback', () => {
  const direct = { mcDesktopTree: { read() {} } }
  assert.equal(desktopTreeBridge(direct), direct.mcDesktopTree)
  const sessions = { mcDesktopSessions: { tree() {} } }
  assert.equal(typeof desktopTreeBridge(sessions).read, 'function')
  assert.equal(desktopTreeBridge({}), null)
})
