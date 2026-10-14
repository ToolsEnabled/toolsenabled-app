/* THE STALE RAIL: SWITCHING TREES MUST NOT LEAVE THE OLD TREE'S CHAT UP.
 *
 * THE DEFECT THIS SUITE EXISTS FOR, measured on a live drive (2026-08-18):
 * open a node's rail chat, press another tree's button in the switcher, and
 * the rail keeps showing the PREVIOUS tree's chat until another circle is
 * pressed. The graph's onRootChange handler repainted the crumb and the
 * switcher and never consulted what the rail was showing
 * (currentRailTreeNode), so the two halves of the page told two different
 * stories about which tree the person was in.
 *
 * THE RULE HELD HERE. The canvas root is a NODE id; that node's own record
 * names the tree now on the canvas. When the rail's node belongs to a
 * different tree -- or to no tree the store knows, which is what a fleet
 * agent's subtree answers -- the rail returns to the overview: the node it
 * was showing cannot be on that canvas, and the overview is the conservative
 * reading of what the person should see. A null root is "Every tree": every
 * tree is on the canvas, so the rail keeps its node.
 *
 * THE CONSTRAINT HELD HERE, which is the part that could destroy work if it
 * slipped: leaving the rail must not touch the transcripts or the streaming
 * accumulator. tools/chat-history-drive.mjs scenarios E and F proved the
 * conversation survives tree switches (10/10, 9/9, a0764ef); the last test in
 * this file refuses any write to the session layer from the follow path, so
 * a green E and F cannot be un-proven from here.
 *
 * WHY AN EXTRACTED FUNCTION RATHER THAN A MOUNT: the view is a 5,000-line
 * closure over a live DOM (tools/test/fleet-page-draws-started-sessions.test.mjs
 * says why that is the house pattern). The driven half of this proof is
 * tools/rail-lifecycle-drive.mjs, which presses the real switcher on a staged
 * packaged build.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const code = view
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))

function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.ok(at !== -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

/* --------------------------- the wiring ---------------------------------- */

test('onRootChange consults the rail, not only the crumb and the switcher', () => {
  const at = code.indexOf('onRootChange:')
  assert.ok(at !== -1, 'the graph mount no longer wires onRootChange at all')
  const handler = code.slice(at, code.indexOf('\n', at))
  assert.match(handler, /renderCrumb\(next, trail\)/, 'the crumb repaint left the handler; that is a different regression')
  assert.match(handler, /refreshTreeSwitch\(\)/, 'the switcher repaint left the handler; that is a different regression')
  assert.match(handler, /railFollowsCanvas\(next\)/,
    'onRootChange never consults what the rail is showing -- switch trees and the rail keeps the previous tree\'s chat until another circle is pressed')
})

/* --------------------------- the behaviour ------------------------------- */

const followSource = () => sliceBlock(code, 'function railFollowsCanvas(rootId) {', 'railFollowsCanvas')

/** The follower, instantiated over fakes that support exactly what it uses. */
function instantiateFollow({ railNode, railOpen, nodes, ancestry = id => [{ id }] }) {
  const calls = { showStats: 0 }
  const controlsPage = { classList: { contains: name => name === 'is-active' && railOpen } }
  const treeStore = { getNode: id => nodes[id] || null }
  const factory = new Function(
    'currentRailTreeNode', 'controlsPage', 'treeStore', 'showStats', 'graph',
    `${followSource()}\nreturn railFollowsCanvas`,
  )
  const follow = factory(railNode, controlsPage, treeStore, () => { calls.showStats += 1 }, { ancestryOf: ancestry })
  return { follow, calls }
}

const NODES = {
  'node-a': { id: 'node-a', treeId: 'tree-1' },
  'node-a2': { id: 'node-a2', treeId: 'tree-1' },
  'node-b': { id: 'node-b', treeId: 'tree-2' },
}

test('switching to another tree returns the rail to the overview', () => {
  const { follow, calls } = instantiateFollow({ railNode: NODES['node-a'], railOpen: true, nodes: NODES })
  follow('node-b')
  assert.equal(calls.showStats, 1,
    'the canvas now shows tree-2 and the rail still shows tree-1\'s node -- the stale rail, exactly as driven')
})

test('drilling within the same tree keeps the rail where the person put it', () => {
  const { follow, calls } = instantiateFollow({ railNode: NODES['node-a'], railOpen: true, nodes: NODES })
  follow('node-a2')
  assert.equal(calls.showStats, 0,
    'a re-root inside the SAME tree bounced the rail to the overview -- that regresses every drill and crumb press')
})

test('a grouped branch retains the rail context of its actual tree', () => {
  const { follow, calls } = instantiateFollow({ railNode: NODES['node-a'], railOpen: true, nodes: NODES,
    ancestry: id => [{ id: 'node-a' }, { id }],
  })
  follow('@tree-group:1')
  assert.equal(calls.showStats, 0)
})

function researchFiler(rootId, trail) {
  let onAssign
  const calls = []
  const nodes = Object.values(NODES).map(node => ({ ...node, sessionId: `session-${node.id}` }))
  const slot = { querySelector: () => null, appendChild: control => { onAssign = control.onAssign } }
  const factory = new Function('root', 'mockSource', 'researchService', 'createAssignmentControl',
    'graph', 'treeStore', 'researchAssignments', 'drivenComputerCopy',
    `${sliceBlock(code, 'function mountResearchScopeControl() {', 'research filing')}\nmountResearchScopeControl()`)
  factory({ querySelector: () => slot }, () => false, { ok: true, projects: [] }, value => value,
    { rootId, ancestryOf: () => trail },
    { getNode: id => nodes.find(node => node.id === id), listNodes: id => nodes.filter(node => node.treeId === id) },
    { snapshot: () => ({ unboundLegacy: false }), assign: async (...args) => { calls.push(args); return { ok: true } } }, value => value)
  return { onAssign, calls }
}

test('research filing inside a collapsed group stays in the group\'s saved tree', async () => {
  const { onAssign, calls } = researchFiler('@tree-group:1', [{ id: 'node-a' }, { id: '@tree-group:1' }])
  assert.equal((await onAssign('project')).ok, true)
  assert.deepEqual(calls, [
    ['project', 'observed', 'session-node-a'],
    ['project', 'observed', 'session-node-a2'],
  ])
})

test('a group spanning several trees never creates a durable assign-all rule', async () => {
  const { onAssign, calls } = researchFiler('@tree-group:2', [{ id: '@tree-group:2' }])
  const result = await onAssign('project')
  assert.equal(result.ok, false)
  assert.match(result.sentence, /Choose a saved tree/)
  assert.deepEqual(calls, [])
})

test('the explicit Every tree view still supports assign-all', async () => {
  const { onAssign, calls } = researchFiler(null, [])
  assert.equal((await onAssign('project')).ok, true)
  assert.deepEqual(calls, [['project', 'all']])
})

test('"Every tree" keeps the rail: a null root puts every tree on the canvas', () => {
  const { follow, calls } = instantiateFollow({ railNode: NODES['node-a'], railOpen: true, nodes: NODES })
  follow(null)
  assert.equal(calls.showStats, 0, 'zooming out to every tree closed a rail whose node is still on the canvas')
})

test('a root the store does not know (a fleet agent) is not the rail\'s tree', () => {
  const { follow, calls } = instantiateFollow({ railNode: NODES['node-a'], railOpen: true, nodes: NODES })
  follow('fleet-agent-9')
  assert.equal(calls.showStats, 1,
    'rooting the canvas on a fleet agent\'s subtree left another tree\'s chat standing in the rail')
})

test('a rail that is not showing a tree node is left alone', () => {
  const closed = instantiateFollow({ railNode: NODES['node-a'], railOpen: false, nodes: NODES })
  closed.follow('node-b')
  assert.equal(closed.calls.showStats, 0, 'the follower re-rendered an overview that was already up')

  const none = instantiateFollow({ railNode: null, railOpen: true, nodes: NODES })
  none.follow('node-b')
  assert.equal(none.calls.showStats, 0, 'the follower acted with no rail node to compare against')
})

/* --------------------------- the constraint ------------------------------ */

test('leaving the rail never touches the conversation or the stream', () => {
  /* chat-history-drive scenarios E and F (a0764ef) proved the transcript and
     the mid-turn accumulator survive tree switches. The follow path must stay
     incapable of un-proving that: it may decide and it may show the overview,
     and nothing else. */
  const follow = followSource()
  for (const forbidden of [
    'sessionTranscripts', 'sessionTurnText', 'transcriptStore', 'persistTranscript',
    'transcriptAppend', 'disposeRailChat', 'disposeRailSaid', 'railChat', 'railSaid',
    'outbox', 'innerHTML', 'showTreeNodeControls',
  ]) {
    assert.ok(!follow.includes(forbidden),
      `railFollowsCanvas touches ${JSON.stringify(forbidden)} -- leaving the rail must not reach into the conversation, the stream, or the queue`)
  }
})

test('POSITIVE CONTROL: the overview return path it uses is the ordinary one', () => {
  /* showStats -> activateRail(statsPage) is the same route a Back press takes.
     If showStats ever grows a write to the session layer, the constraint above
     is being bypassed one call deeper. */
  const stats = sliceBlock(code, 'function showStats() {', 'showStats')
  for (const forbidden of ['sessionTranscripts', 'sessionTurnText', 'persistTranscript', 'transcriptAppend']) {
    assert.ok(!stats.includes(forbidden), `showStats now touches ${forbidden}; the rail-follow constraint is hollow`)
  }
})
