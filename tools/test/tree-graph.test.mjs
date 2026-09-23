import assert from 'node:assert/strict'
import test from 'node:test'

import {
  StaticTreeGraph,
  TREE_CONTEXT_READ_FAILED,
  TREE_EMPTY_PRESS_EVENT,
  TREE_POSITIONS_READ_FAILED,
} from '../../src/tree-graph.js'
import { layoutTree } from '../../src/tree-layout.js'
import { TEXT_SIZES } from '../../src/text-size.js'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

const graph = computer => Object.assign(Object.create(StaticTreeGraph.prototype), { computer })

test('graph refresh preserves parent attributes while status changes flow through and reparenting relayouts', () => {
  const subject = graph({ agents: [
    { id: 'root', role: 'controller', parentId: null },
    { id: 'other', role: 'manager', parentId: 'root' },
    { id: 'child', role: 'worker', parentId: 'root' },
  ] })
  const writes = [], refreshed = []
  let layouts = 0
  subject.nodes = new Map(subject.computer.agents.map(agent => {
    const el = new Element('div')
    el.dataset.parentId = agent.parentId || ''
    const setAttribute = el.setAttribute.bind(el)
    el.setAttribute = (name, value) => {
      if (name === 'data-parent-id') writes.push([agent.id, value])
      setAttribute(name, value)
    }
    return [agent.id, { id: agent.id, agent, el }]
  }))
  for (const method of ['_renderRuntime', '_renderLaneMarks', '_renderChipPreview', '_refreshChatSession']) {
    subject[method] = record => refreshed.push([method, record.agent])
  }
  subject._syncConversationShelf = () => {}
  subject._layoutNow = () => {
    layouts++
    subject._layoutResult = {}
    subject._layoutKey = subject._structureKey()
  }
  subject._layoutNow()
  const originalLayout = subject._layoutResult

  for (let revision = 0; revision < 100; revision++) {
    subject.computer.agents = subject.computer.agents.map(agent => ({ ...agent, state: `status-${revision}` }))
    subject._reconcile()
  }
  assert.equal(writes.length, 0, 'status refreshes must not rewrite unchanged parent attributes')
  assert.equal(subject._layoutResult, originalLayout)
  assert.equal(layouts, 1)
  assert.equal(refreshed.length, 100 * 3 * 4, 'runtime, lane, preview and chat updates still run')
  for (const [, agent] of refreshed.slice(-12)) assert.equal(agent.state, 'status-99')

  for (const parentId of ['other', null]) {
    writes.length = 0
    const child = { ...subject.computer.agents[2], parentId }
    subject.computer.agents[2] = child
    const previousLayout = subject._layoutResult
    subject._reconcile()
    assert.equal(subject.nodes.get('child').agent, child)
    assert.equal(subject.nodes.get('child').el.dataset.parentId, parentId || '')
    assert.deepEqual(writes, [['child', parentId || '']], 'only the changed parent is written')
    assert.notEqual(subject._layoutResult, previousLayout)
    subject._reconcile()
    assert.deepEqual(writes, [['child', parentId || '']], 'the new parent is stable on subsequent refreshes')
  }
  assert.equal(layouts, 3, 'both reparenting and detaching still update geometry')
})

// Extend the small DOM stand-in only with comma unions and tag/attribute
// matching used by pointer target classification. Native pointer capture and
// painted geometry are covered by the independent Chromium/WebKit check.
class PointerTarget extends Element {
  matches(selector) {
    return selector.split(',').some(part => {
      const query = part.trim()
      const qualified = /^([a-z]+)(\[[^\]]+\])$/i.exec(query)
      return qualified
        ? super.matches(qualified[1]) && super.matches(qualified[2])
        : super.matches(query)
    })
  }
}

function pointerGraph() {
  const subject = graph({ agents: [] })
  const captures = [], released = []
  const host = new PointerTarget('div')
  host.setPointerCapture = id => captures.push(id)
  host.releasePointerCapture = id => released.push(id)
  Object.assign(subject, { zoomHost: host, nodes: new Map(), panX: 0, panY: 0, editMode: false })
  subject._wireHostInteractions()
  return { subject, host, captures, released }
}

test('graph pan leaves real links and their descendants free to receive mouse and touch activation', () => {
  for (const pointerType of ['mouse', 'touch']) {
    for (const descendant of [false, true]) {
      const { subject, host, captures } = pointerGraph()
      const anchor = new PointerTarget('a')
      anchor.setAttribute('href', '/signin/')
      host.appendChild(anchor)
      const target = descendant ? new PointerTarget('span') : anchor
      if (descendant) anchor.appendChild(target)
      subject._onPanDown({ preventDefault() {}, button: 0, pointerId: 9, pointerType, clientX: 24, clientY: 40, target })
      assert.equal(subject._panState, undefined, 'a navigation action must not start graph dragging')
      assert.deepEqual(captures, [], 'capturing the pointer would move Chromium click activation off the anchor')
      assert.equal(host.classList.contains('panning'), false)
    }
  }
})

test('graph background still starts and ends a pan while existing buttons remain interactive', () => {
  const { subject, host, captures, released } = pointerGraph()
  const button = new PointerTarget('button')
  host.appendChild(button)
  subject._onPanDown({ preventDefault() {}, button: 0, pointerId: 8, target: button })
  assert.deepEqual(captures, [])
  subject._onPanDown({ preventDefault() {}, button: 0, pointerId: 9, clientX: 24, clientY: 40, target: host })
  assert.deepEqual(captures, [9])
  assert.equal(host.classList.contains('panning'), true)
  assert.equal(subject._panState.id, 9)
  subject._onPanEnd({ pointerId: 9 })
  assert.equal(subject._panState, null)
  assert.deepEqual(released, [9])
  assert.equal(host.classList.contains('panning'), false)
})

test('a second pointer cannot take over the camera or start a node drag during a pan', () => {
  const { subject, host, captures, released } = pointerGraph()
  const down = pointerId => ({ preventDefault() {}, button: 0, pointerId,
    clientX: 24, clientY: 40, target: host })
  subject._onPanDown({ ...down(7), isPrimary: false })
  assert.deepEqual(captures, [], 'a remaining secondary touch cannot start a fresh pan')
  subject._onPanDown(down(8))
  const initial = subject._panState
  subject._onPanDown(down(9))
  assert.equal(subject._panState, initial)
  assert.deepEqual(captures, [8])
  subject.editMode = true
  const record = { id: 'child', agent: { id: 'child' }, el: new Element('div') }
  record.el.setPointerCapture = id => captures.push(id)
  subject._wireNode(record)
  record.el.dispatch('pointerdown', down(9))
  assert.deepEqual(captures, [8], 'a node and the camera cannot own competing gestures')
  subject._onPanEnd({ pointerId: 9 })
  assert.equal(subject._panState, initial)
  assert.deepEqual(released, [])
  subject._onPanEnd({ pointerId: 8 })
  assert.equal(subject._panState, null)
  assert.deepEqual(released, [8])
})

test('a drilled tree contains its root and every descendant, regardless of record order', () => {
  const agents = [
    { id: 'leaf', parentId: 'child' },
    { id: 'elsewhere', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'root', parentId: null },
  ]

  assert.deepEqual(
    graph({ agents }).visibleAgents('root').map(agent => agent.id),
    ['leaf', 'child', 'root'],
    'drilling into a node must retain its complete branch in the caller\'s stable record order',
  )
})

function screenshotFleet() {
  // The saved 09:13:55 preview: Controller + five Builders + Manager + eleven
  // Workers in one tree, and Reviewer + one Builder in the other. All are drafts.
  const node = (id, name, parentId, treeId) => ({ id, name, parentId, treeNode: { treeId, status: 'draft' } })
  return [
    node('controller', 'Controller', null, 'workspace'),
    ...Array.from({ length: 5 }, (_, i) => node(`builder-${i}`, `Builder ${i + 1}`, 'controller', 'workspace')),
    node('manager', 'Manager', 'controller', 'workspace'),
    ...Array.from({ length: 11 }, (_, i) => node(`worker-${i}`, `Worker ${i + 1}`, 'manager', 'workspace')),
    node('reviewer', 'Reviewer', null, 'review'),
    node('review-builder', 'Builder', 'reviewer', 'review'),
  ]
}

test('both tree shapes reproduce the saved twenty-agent screenshot at its 752px canvas width', () => {
  const agents = screenshotFleet(), original = structuredClone(agents)
  for (const nodeStyle of ['circles', 'boxes']) {
    const subject = Object.assign(graph({ agents }), { nodeStyle, zoomHost: { clientWidth: 752 } })
    const overview = subject.visibleAgents()
    assert.deepEqual(overview.map(agent => ({
      id: agent.id, name: agent.name, summary: agent.treeScope?.summary,
      hidden: agent.treeScope?.hidden, group: agent.treeScope?.group,
    })), [
      { id: 'controller', name: 'Controller', summary: { total: 18, working: 0, review: 0, finished: 0 }, hidden: 17, group: false },
      { id: 'reviewer', name: 'Reviewer', summary: { total: 2, working: 0, review: 0, finished: 0 }, hidden: 1, group: false },
    ], 'the two real roots retain the full 18/2 context and +17/+1 descendant badges')
    for (const width of [1000, 1400]) {
      subject.zoomHost.clientWidth = width
      assert.deepEqual(subject.visibleAgents(), agents, 'the same original policy shows all twenty when the canvas is wide enough')
    }
  }
  assert.deepEqual(agents, original, 'changing the view must not rewrite saved agents')
})

test('selected trees retain screenshot summaries and every drilled descendant while excluding forty unrelated agents', () => {
  const selected = screenshotFleet()
  const unrelated = [25, 15].flatMap((count, tree) => Array.from({ length: count }, (_, index) => ({
    id: `other-${tree}-${index}`, name: `Other ${tree} agent ${index}`,
    parentId: index ? `other-${tree}-0` : null,
    treeNode: { treeId: `other-${tree}`, status: 'running' },
  })))
  const agents = [...selected, ...unrelated], original = structuredClone(agents)
  const selectedIds = new Set(selected.map(agent => agent.id))
  for (const nodeStyle of ['circles', 'boxes']) {
    const subject = Object.assign(graph({ agents }), {
      nodeStyle, zoomHost: { clientWidth: 752 }, windowRootIds: ['controller', 'reviewer'],
    })
    const overview = subject.visibleAgents()
    assert.deepEqual(overview.map(agent => agent.id), ['controller', 'reviewer'])
    assert.equal(subject._scopeAgentCount(), 20, 'the canvas count describes its selected trees, not the sixty-agent fleet')
    assert.deepEqual(overview.map(agent => agent.treeScope.summary), [
      { total: 18, working: 0, review: 0, finished: 0 },
      { total: 2, working: 0, review: 0, finished: 0 },
    ], 'working agents in excluded trees cannot enter either selected summary')
    assert.deepEqual(overview.map(agent => agent.treeScope.hidden), [17, 1])
    assert.ok(overview.every(agent => !agent.treeScope.group))

    const pending = [null], visited = new Set(), seen = new Set()
    while (pending.length) {
      const rootId = pending.pop()
      assert.equal(visited.has(rootId), false, 'branch navigation must make progress')
      visited.add(rootId)
      for (const agent of subject.visibleAgents(rootId)) {
        if (!agent.treeScope?.group) {
          assert.ok(selectedIds.has(agent.id), 'no unrelated real agent enters a selected branch')
          seen.add(agent.id)
        }
        if (agent.treeScope) {
          const represented = subject._scopeModel().branch(agent.id)
          assert.ok(represented.every(id => selectedIds.has(id)), 'embedded branch members stay inside the selected forest')
          assert.deepEqual(agent.treeScope.summary, { total: represented.length, working: 0, review: 0, finished: 0 })
        }
        if (agent.treeScope?.expandable) pending.push(agent.id)
      }
    }
    assert.deepEqual(seen, selectedIds, 'all twenty selected agents remain reachable through branch focus')
    subject.zoomHost.clientWidth = 1200
    assert.deepEqual(subject.visibleAgents(), selected, 'a wider view expands only the selected trees')
    assert.deepEqual(subject.visibleAgents('manager'), selected.filter(agent => agent.id === 'manager' || agent.parentId === 'manager'),
      'explicit branch focus excludes the other selected root as well as unrelated trees')
    subject.rootId = 'manager'
    assert.equal(subject._scopeAgentCount(), 12, 'a focused branch counts its complete underlying descendants')
  }
  assert.deepEqual(agents, original)
})

test('boxes and circles draw the original rounded shared-bus hierarchy', () => {
  const routes = []
  for (const nodeStyle of ['circles', 'boxes']) {
    const subject = Object.assign(graph({ agents: [] }), { nodeStyle, spacious: false })
    const parent = { x: 100, y: 100, r: 112, agent: {} }
    const child = { x: 500, y: 650, r: 112, agent: {} }
    const route = subject._elbowRoute(parent, child, 350)
    assert.deepEqual(route.segments, [
      { x1: 100, y1: 212, x2: 100, y2: 350 },
      { x1: 100, y1: 350, x2: 500, y2: 350 },
      { x1: 500, y1: 350, x2: 500, y2: 538 },
    ])
    assert.match(route.d, /Q 100 350 109 350/, 'the branch uses the original rounded elbow')
    routes.push(route)
  }
  assert.deepEqual(routes[0], routes[1], 'shape choice does not select a different hierarchy renderer')
})

test('ancestry is root-first and terminates safely when caller data contains a cycle', () => {
  const subject = graph({ agents: [
    { id: 'child', name: 'Child', parentId: 'root' },
    { id: 'root', name: 'Root', parentId: 'child' },
  ] })

  assert.deepEqual(
    subject.ancestryOf('child'),
    [{ id: 'root', name: 'Root' }, { id: 'child', name: 'Child' }],
    'breadcrumbs must be root-first and must not repeat records from a cyclic projection',
  )
})

test('an extension predicate that could not be read remains unknown, not a definite refusal', () => {
  const subject = graph({ agents: [] })
  subject.canExtend = () => { throw new Error('store is temporarily unreadable') }

  assert.equal(
    subject._canExtend(null),
    true,
    'a thrown canExtend read must preserve the extension offer instead of converting unknown to no',
  )
})

test('busy position and context reads never become absent answers or poison later reads', () => {
  const subject = graph({ id: 'computer-7', agents: [] })
  const originalStorage = globalThis.localStorage
  let reads = 0
  globalThis.localStorage = {
    getItem() {
      reads += 1
      if (reads === 1) throw Object.assign(new Error('device busy'), { code: 'EBUSY' })
      return JSON.stringify({ root: { v: 2, dx: 4, dy: 6, parentId: null, at: 1 } })
    },
  }
  try {
    assert.throws(
      () => subject._readPositions(),
      error => error.code === TREE_POSITIONS_READ_FAILED
        && /not claiming that no saved positions exist/i.test(error.message)
        && error.cause?.code === 'EBUSY',
      'EBUSY must have a named could-not-tell result rather than an empty positions object',
    )

    subject._positions = subject._readPositions()
    assert.equal(subject.hasPositionOverrides(), true, 'a later successful read must still find the saved override')
    assert.equal(subject.hasPositionOverrides(), true, 'the successfully read positions remain cached for cheap UI checks')
    assert.equal(reads, 2, 'only the failed read is retried; successful position state remains cached')
  } finally {
    globalThis.localStorage = originalStorage
  }

  let contextReads = 0
  subject.contextFeed = () => {
    contextReads += 1
    if (contextReads === 1) throw Object.assign(new Error('device busy'), { code: 'EAGAIN' })
    return { activities: ['available on retry'] }
  }
  const record = { agent: {} }
  const unavailable = subject._screenContext(record)
  assert.equal(unavailable.unavailableCode, TREE_CONTEXT_READ_FAILED)
  assert.match(unavailable.unavailable, /not claiming that no context exists/i)
  assert.equal(subject._screenContext(record).current, 'available on retry', 'a failed context read must not be cached')
  assert.equal(contextReads, 2)
})

test('page-2 workspaces keep tree creation in the header without moving existing agents', () => {
  const agents = [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }]
  for (const nodeStyle of ['circles', 'boxes']) for (const frame of [{ tabbedWorkspace: true }, { chatOwner: {} }]) {
    const subject = Object.assign(graph({ agents }), frame, {
      rootId: null, emptySlotsEnabled: true, nodeStyle, W: 900, H: 600,
    })
    const fleetLayout = layoutTree({ nodes: agents, edges: [], W: 900, H: 600 })
    for (const editMode of [false, true]) {
      subject.editMode = editMode
      const { plans, layout } = subject._settleEmptySlots({ agents, edges: [], fleetLayout })
      assert.equal(plans.some(plan => plan.kind === 'new-tree'), false, 'no second tree-creation control inside either workspace frame')
      assert.equal(layout.slots.has('empty:new-tree'), false, 'the removed control leaves no layout placeholder')
      assert.deepEqual(plans.map(plan => plan.parentId), nodeStyle === 'boxes' && !editMode ? [] : ['root', 'child'])
      if (!editMode) for (const agent of agents) assert.deepEqual(layout.slots.get(agent.id), fleetLayout.slots.get(agent.id))
    }
    assert.deepEqual(subject._planEmptySlots([], { slots: new Map(), culled: new Set() }), [], 'an empty workspace also uses its header')
  }
})

test('slot copy distinguishes adding another tree from adding a child', () => {
  const subject = graph({ agents: [] })
  Object.assign(subject, {
    rootId: null,
    emptySlotsEnabled: true,
    _destroyed: false,
    canExtend: null,
  })
  const parent = { id: 'root', parentId: null }
  const [newTree, child] = subject._planEmptySlots([parent], {
    slots: new Map([['root', {}]]),
    culled: new Set(),
  })

  assert.deepEqual(
    {
      newTreeNamesAnAdditionalGroup: /another|second|additional/i.test(newTree.name),
      newTreeExplainsSeparation: /apart|separate|different/i.test(newTree.hint),
      childOffersAnAgent: /agent/i.test(child.name) && /start/i.test(child.hint),
    },
    {
      newTreeNamesAnAdditionalGroup: true,
      newTreeExplainsSeparation: true,
      childOffersAnAgent: true,
    },
    'slot words must distinguish a separate tree from an agent position without pinning exact copy',
  )
})

/* The owner's defect: a tree he had already grown could not be grown any
   further from its own view. Every agent on it still had legal room for a
   child, and the separate "start another tree" offer was still there in the
   overview — which is exactly why it read as the page losing a button rather
   than as a limit being reached. The cause was a count: past twelve drawn
   agents the graph withdrew every child offer before the layout was allowed to
   say whether they fit. These two tests are that tree, at that boundary. */
test('a tree past the drill-in density still offers a position under every agent that can take one', () => {
  const agents = Array.from({ length: 12 }, (_, index) => ({
    id: index === 0 ? 'root' : `agent-${index}`,
    parentId: index === 0 ? null : 'root',
  }))
  const subject = graph({ agents })
  Object.assign(subject, {
    rootId: 'root',
    emptySlotsEnabled: true,
    _destroyed: false,
    canExtend: agent => agent?.id !== 'agent-5',
  })

  const plans = subject._planEmptySlots(agents, {
    slots: new Map(agents.map(agent => [agent.id, {}])),
    culled: new Set(),
  })

  assert.deepEqual(
    {
      offeredUnder: plans.filter(plan => plan.kind === 'child').map(plan => plan.parentId).sort(),
      offersAnotherTree: plans.some(plan => plan.kind === 'new-tree'),
    },
    {
      offeredUnder: agents.map(agent => agent.id).filter(id => id !== 'agent-5').sort(),
      offersAnotherTree: false,
    },
    'a crowded canvas may invite drilling in, but it must not withdraw the only way to extend the tree — while the model still decides which positions are legal, and a drilled view still keeps the separate-tree offer out',
  )
})

test('the offer settlement keeps a dense tree extendable without costing an agent its place', () => {
  const agents = [
    { id: 'root', name: 'Root', role: 'default', parentId: null },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `manager-${index}`,
      name: `Manager ${index}`,
      role: 'default',
      parentId: 'root',
    })),
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `worker-${index}`,
      name: `Worker ${index}`,
      role: 'default',
      parentId: `manager-${index % 5}`,
    })),
  ]
  const subject = graph({ agents })
  Object.assign(subject, {
    rootId: 'root',
    emptySlotsEnabled: true,
    _destroyed: false,
    canExtend: () => true,
    W: 900,
    H: 600,
  })
  const fleetLayout = layoutTree({ nodes: agents, edges: [], W: 900, H: 600 })
  const { plans, layout } = subject._settleEmptySlots({ agents, edges: [], fleetLayout })

  assert.deepEqual(
    {
      agentsOnTheTree: agents.length,
      agentsTheOffersCostTheirPlace: agents
        .filter(agent => fleetLayout.slots.has(agent.id) && !layout.slots.has(agent.id))
        .map(agent => agent.id),
      hasSomewhereToPress: plans.some(plan =>
        layout.slots.has(plan.id) && !layout.culled.has(plan.id)),
    },
    {
      agentsOnTheTree: 18,
      agentsTheOffersCostTheirPlace: [],
      hasSomewhereToPress: true,
    },
    'the layout may cull individual offers to keep a rank readable, but the tree the owner already grew must keep at least one drawn place to press, and no agent may vanish to make room for one',
  )
})

test('pressing a child offer reports its tree context without starting or changing anything', () => {
  const agents = [
    { id: 'root', name: 'Root', parentId: null },
    { id: 'parent', name: 'Parent', parentId: 'root' },
  ]
  const subject = graph({ id: 'computer-7', agents })
  subject._destroyed = false
  let callbackDetail
  let dispatched
  subject.onEmptyPress = detail => { callbackDetail = detail }
  subject.container = { dispatchEvent: event => { dispatched = event } }

  const OriginalCustomEvent = globalThis.CustomEvent
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options) }
  }
  try {
    subject._pressEmptySlot({ id: 'empty:child:parent', kind: 'child', parentId: 'parent' }, 'keyboard')
  } finally {
    globalThis.CustomEvent = OriginalCustomEvent
  }

  assert.deepEqual(
    {
      callbackDetail,
      event: { type: dispatched.type, detail: dispatched.detail, bubbles: dispatched.bubbles },
    },
    {
      callbackDetail: {
        kind: 'child',
        slotId: 'empty:child:parent',
        parentId: 'parent',
        parent: agents[1],
        treeId: 'root',
        computerId: 'computer-7',
        via: 'keyboard',
      },
      event: { type: TREE_EMPTY_PRESS_EVENT, detail: callbackDetail, bubbles: true },
    },
    'a child-slot press must report its parent, tree, computer, and input route through both public notification paths',
  )
})

/* ==================================================================
   THE FIT: DRAW THE TREE IN THE CANVAS THERE ACTUALLY IS.
   ==================================================================

   THE DEFECT THESE PIN. A phone turned sideways lost its entire fleet.
   Measured on the served build 2026-08-28, 750x342, Chromium and WebKit
   alike: `.graph-canvas-slot` resolved to ZERO pixels tall, all five agents
   were laid out 200-390px below the screen, the page did not scroll
   (scrollHeight === innerHeight), a real touch pan moved nothing, five presses
   of Zoom out stopped at 0.50x with the fleet still gone, and "Reset zoom to
   overview" -- whose whole name is a promise to show the overview -- set the
   zoom to 1 and the pan to zero and changed nothing. The only remedy was
   rotating the phone back, and nothing on screen said so.

   The layout is allowed to ask for more height than the pane has; that ask is
   addressed to a page that can scroll. On a phone the page CANNOT scroll --
   that is the phone canvas's central promise -- so the ask is a request nobody
   answers. These gates are the other answer: measure what is drawn, and draw
   it smaller. */

/** A graph whose pane and container are numbers rather than a browser. */
function fitted({ pane = { w: 800, h: 100 }, origin = { x: 0, y: 0 }, nodes = [], locked = true } = {}) {
  const records = new Map(nodes.map((node, index) => [node.id || `n${index}`, {
    id: node.id || `n${index}`,
    x: node.x,
    y: node.y,
    r: node.r,
    el: {
      hidden: false,
      querySelector: () => (node.label
        ? { offsetWidth: node.label.width, offsetHeight: node.label.height, offsetTop: node.r * 2 + 7 }
        : null),
    },
  }]))
  const style = { overflowY: locked ? 'hidden' : 'visible' }
  const documentStandIn = {
    documentElement: { scrollHeight: 2000, clientHeight: 400, parentElement: null },
    body: { parentElement: null },
    defaultView: { getComputedStyle: () => style },
  }
  documentStandIn.defaultView.document = documentStandIn
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    W: pane.w,
    H: 600,
    zoom: 1,
    panX: 0,
    panY: 0,
    nodes: records,
    emptySlots: new Map(),
    _culled: new Set(),
    zoomHost: {
      clientWidth: pane.w,
      clientHeight: pane.h,
      parentElement: null,
      ownerDocument: documentStandIn,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: pane.w, height: pane.h }),
    },
    container: {
      /* The painted rect MOVES with the pan, exactly as a browser reports it:
         the transform is `translate(pan) scale(zoom)` about 0 0, so the box
         top-left is its layout position plus the pan. _hostOffset takes the
         pan back off to recover the layout position, and a stand-in that
         held still would make that subtraction meaningless. */
      getBoundingClientRect: function () { return { left: origin.x + subject.panX, top: origin.y + subject.panY, width: pane.w, height: 600 } },
    },
    /* The transform is what the browser paints; these gates are about the
       numbers that go into it. */
    _applyZoom() { this.applied = (this.applied || 0) + 1 },
  })
  return subject
}

const TALL_TREE = [
  { id: 'root', x: 400, y: 60, r: 44, label: { width: 160, height: 34 } },
  { id: 'left', x: 200, y: 300, r: 40, label: { width: 160, height: 34 } },
  { id: 'right', x: 600, y: 300, r: 40, label: { width: 160, height: 34 } },
]

test('the drawn box is the circles AND their names, not the canvas the layout was given', () => {
  const subject = fitted({ nodes: TALL_TREE })
  const box = subject._contentBox()
  assert.equal(box.x, 120, 'the widest thing on the left is a 160px name under a circle at x=200')
  assert.equal(box.y, 16, 'the top is the top of the root circle')
  assert.equal(box.w, 560, 'the box spans from the left name to the right one')
  /* 300 - 40 + (80 + 7) + 34 = 381: the label stack hangs below its circle,
     and an agent whose name is off the screen is an agent you cannot read. */
  assert.equal(box.y + box.h, 381, 'the bottom is the bottom of the lowest NAME, never of the lowest circle')
  assert.equal(fitted({ nodes: [] })._contentBox(), null, 'an empty tree has no box, and a fit of nothing must be refusable')
})

test('a fit contains the whole tree and modestly enlarges a sparse overview', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 800, h: 100 } })
  assert.equal(subject.fitToHost(), true, 'a tree and a pane are all a fit needs')
  assert.ok(subject.zoom < 0.5,
    `the fit must be allowed past the stepped floor of 0.5x -- it needed ${subject.zoom.toFixed(2)}x -- or it is a fit that still loses agents`)
  assert.equal(subject._contentIsInsideHost(subject._contentBox()), true, 'after a fit, every circle and every name is inside the pane')

  const roomy = fitted({ nodes: TALL_TREE, pane: { w: 2000, h: 1200 } })
  roomy.fitToHost()
  assert.ok(roomy.zoom > 1 && roomy.zoom <= 1.25, 'spare space improves readability without magnifying a sparse tree without bound')
  assert.equal(roomy._contentIsInsideHost(roomy._contentBox()), true)
})

test('a fit accounts for where the container sits inside the pane', () => {
  /* An over-constrained absolutely positioned container does not start at the
     pane's top-left: measured 2026-08-28, a 506px container in a 79px pane
     started 21px ABOVE it. Assuming zero put every comparison out by that
     amount. */
  const offset = fitted({ nodes: TALL_TREE, pane: { w: 800, h: 100 }, origin: { x: 0, y: -21 } })
  offset.fitToHost()
  assert.equal(offset._contentIsInsideHost(offset._contentBox()), true,
    'the fit must land inside the pane even when the container it scales does not start there')
})

test('text-scale coordinates preserve the pointer anchor and measured origin at every offered size', () => {
  for (const uiZoom of [0.9, 1, 1.12]) {
    const subject = fitted({ nodes: TALL_TREE, pane: { w: 800, h: 900 } })
    subject.zoomHost.ownerDocument.body.style = { zoom: String(uiZoom) }
    subject.zoomHost.clientLeft = 2
    subject.zoomHost.clientTop = 3
    subject.zoomHost.getBoundingClientRect = () => ({ left: 40, top: 60 })
    subject.panX = -30; subject.panY = 20; subject.zoom = 1.4
    subject.container.getBoundingClientRect = () => ({ left: 40 + (7 + subject.panX) * uiZoom, top: 60 + (11 + subject.panY) * uiZoom })
    const origin = subject._hostOffset()
    assert.ok(Math.abs(origin.x - 7) < 1e-8 && Math.abs(origin.y - 11) < 1e-8)
    const point = subject._toGraph({ clientX: 40 + (2 - 30 + 100 * 1.4) * uiZoom, clientY: 60 + (3 + 20 + 200 * 1.4) * uiZoom })
    assert.ok(Math.abs(point.x - 100) < 1e-8 && Math.abs(point.y - 200) < 1e-8)
  }
})

test('automatic layout never overwrites a manually steered view', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 2000, h: 1200 } })
  subject._viewSteered = true
  subject.zoom = 0.64; subject.panX = -70; subject.panY = 28
  subject._autoFitToHost()
  assert.deepEqual([subject.zoom, subject.panX, subject.panY], [0.64, -70, 28])
})

test('a visible branch with entirely culled children still offers the drill that reveals them', () => {
  const agents = [
    { id: 'root' }, { id: 'branch', parentId: 'root' },
    { id: 'hidden', parentId: 'branch' }, { id: 'other', parentId: 'root' },
    { id: 'deeper', parentId: 'other' }, { id: 'deep-child', parentId: 'deeper' },
  ]
  const marked = new Map()
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    rootId: null, _realDrillRequired: true,
    _layoutVisibleIds: new Set(agents.map(a => a.id)), _culled: new Set(['hidden']),
    nodes: new Map(agents.map(agent => [agent.id, { id: agent.id, agent, el: { classList: { toggle: (name, on) => marked.set(agent.id, on) } } }])),
  })
  subject.updateDensity()
  assert.equal(marked.get('branch'), true, 'a culled child must not make its branch look like a leaf')
  assert.equal(marked.get('deeper'), true, 'the existing deepest visible branch still drills')
  assert.equal(marked.get('hidden'), false, 'a culled node itself is not a visible action')
  assert.equal(marked.get('deep-child'), false, 'a real leaf does not promise a drill')
})

test('"reset to overview" returns to a centered readable fit, including after manual zoom', () => {
  const roomy = fitted({ nodes: TALL_TREE, pane: { w: 2000, h: 1200 } })
  roomy.zoom = 2
  roomy.panX = -300
  roomy.panY = -120
  roomy.resetToOverview()
  assert.ok(roomy.zoom > 1 && roomy.zoom <= 1.25)
  assert.equal(roomy._contentIsInsideHost(roomy._contentBox()), true)
  assert.equal(roomy._viewSteered, false, 'a requested overview resumes automatic fitting on future resizes')

  const cramped = fitted({ nodes: TALL_TREE, pane: { w: 800, h: 100 } })
  cramped.resetToOverview()
  assert.ok(cramped.zoom < 1 && cramped._contentIsInsideHost(cramped._contentBox()),
    'a tree that does not fit is fitted, because that is what the control is named for')
})

test('a locked page is not a page that can be scrolled to the rest of the tree', () => {
  /* THE MISS. The document reports content taller than its box whether or not
     anything may scroll it, and reading that number alone said "the reader can
     get there" for a page pinned by src/phone-canvas.css. The second rotation
     into landscape then kept 1.00x with agents off the screen. */
  assert.equal(fitted({ locked: true })._overflowIsReachable(), false,
    'html and body with hidden overflow cannot be scrolled, whatever scrollHeight says')
  assert.equal(fitted({ locked: false })._overflowIsReachable(), true,
    'an ordinary page that is taller than its window can be scrolled, and the height ask is addressed to it')
})

test('zoom-out leaves generous whitespace, stops at a finite overview limit, and Fit recovers it', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 1000, h: 700 } })
  subject.fitToHost()
  const overview = subject.zoom
  for (let press = 0; press < 30; press += 1) subject.zoomBy(1 / 1.25)
  assert.ok(subject.zoom >= overview * 0.3 && subject.zoom <= overview * 0.4,
    'the outer stop leaves nearly three times the viewing room of Fit')
  assert.equal(subject._contentIsInsideHost(subject._contentBox()), true)
  const stopped = [subject.zoom, subject.panX, subject.panY]
  for (let press = 0; press < 30; press += 1) subject.zoomBy(1 / 1.25)
  assert.deepEqual([subject.zoom, subject.panX, subject.panY], stopped, 'continued input cannot shrink or drift the overview')
  subject.zoomBy(1.2)
  assert.ok(subject.zoom > stopped[0], 'inward zoom responds immediately at the stop')
  subject.fitCurrentTree()
  assert.ok(Math.abs(subject.zoom - overview) < 1e-9)
  assert.equal(subject._contentIsInsideHost(subject._contentBox()), true)
})

test('zoom-out still fits huge edit trees below the ordinary absolute minimum', () => {
  const subject = fitted({ pane: { w: 1000, h: 700 }, nodes: Array.from({ length: 1000 }, (_, i) =>
    ({ id: `n${i}`, x: i * 100, y: i * 50, r: 34 })) })
  Object.assign(subject, { editMode: true, spacious: true, smartScope: true })
  subject.fitToHost()
  const fittedScale = subject.zoom
  assert.ok(fittedScale < 0.05)
  subject.zoomBy(0.01)
  assert.ok(subject.zoom > 0 && subject.zoom < fittedScale / 2)
  assert.equal(subject._contentIsInsideHost(subject._contentBox()), true)
  assert.equal(subject.nodes.size, 1000)
})

test('a smaller pane permits a wider overview and outward input never jumps a restored view inward', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 1000, h: 700 } })
  subject.fitToHost()
  const oldFloor = subject._zoomOutFloor()
  subject.zoomHost.clientWidth = 200
  assert.ok(subject._zoomOutFloor() < oldFloor, 'manual resize cannot trap content above its new geometric fit')
  subject.zoom = subject._zoomOutFloor() / 2
  const restored = subject.zoom
  subject.zoomBy(0.5)
  assert.equal(subject.zoom, restored, 'outward input holds a saved camera already below the new floor')
  subject.zoomBy(1.2)
  assert.equal(subject.zoom, restored * 1.2)
})

test('add circles follow the rendered agent radius, position and zoom', () => {
  const parent = { id: 'parent', x: 300, y: 250, r: 39, agent: {}, el: { hidden: false } }
  const subject = Object.assign(graph({ agents: [parent.agent] }), {
    spacious: true, editMode: false, _fitFloor: 0.32,
    zoomHost: { clientHeight: 800 }, nodes: new Map([[parent.id, parent]]),
  })
  const slot = { parentId: parent.id, r: 14, x: 0, y: 0 }
  for (const zoom of [0.05, 0.15, 0.32, 1.2]) {
    const point = subject._emptyGeometry(slot, zoom)
    const gap = Math.hypot(point.x - parent.x, point.y - parent.y) * zoom
      - (parent.r + slot.r) * subject._nodeScale(zoom) * zoom
    assert.ok(Math.abs(gap - 8) < 1e-8, 'the add circle keeps an 8px gap from its agent')
    assert.ok(point.x > parent.x && point.y < parent.y)
  }
  assert.ok(subject._nodeScale(0.05) * 0.05 < subject._nodeScale(0.32) * 0.32, 'manual zoom-out also shrinks the circles')
  const before = subject._emptyGeometry(slot, 0.32)
  parent.x += 100; parent.y += 40
  const after = subject._emptyGeometry(slot, 0.32)
  assert.ok(Math.abs(after.x - before.x - 100) < 1e-8)
  assert.ok(Math.abs(after.y - before.y - 40) < 1e-8)
})

test('zooming in and out keeps the chosen world point under the pointer', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 1000, h: 800 } })
  subject.panX = -50; subject.panY = 20
  const point = { x: 450, y: 300 }, anchor = { x: 400, y: 320 }
  subject.zoomBy(1.2, anchor.x, anchor.y)
  assert.ok(Math.abs(subject.panX + point.x * subject.zoom - anchor.x) < 1e-8)
  assert.ok(Math.abs(subject.panY + point.y * subject.zoom - anchor.y) < 1e-8)
  subject.zoomBy(1 / 1.2, anchor.x, anchor.y)
  assert.ok(Math.abs(subject.zoom - 1) < 1e-8)
  assert.ok(Math.abs(subject.panX + 50) < 1e-8)
  assert.ok(Math.abs(subject.panY - 20) < 1e-8)
})

test('wheel zoom never replaces a fully visible tree with the nearby leaf', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 1000, h: 800 } })
  subject.zoom = 1.5
  subject.computer = { agents: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })) }
  subject._nearestRecordTo = () => ({ id: 'leaf', agent: {} })
  subject._captureRootAt = () => { throw new Error('Zoom must not replace the visible hierarchy') }
  subject.zoomBy(1.2, 400, 320, { explore: true })
  assert.ok(subject.zoom > 1.5)
  assert.equal(subject.rootId || null, null)
  subject.rootId = 'chosen-tree'
  subject.zoomBy(0.4, 400, 320, { explore: true })
  assert.equal(subject.rootId, 'chosen-tree', 'zoom-out keeps an explicitly selected tree selected')
})

test('Fit frames the current branch without changing tree selection', () => {
  const subject = fitted({ nodes: TALL_TREE, pane: { w: 1000, h: 800 } })
  subject.rootId = 'chosen-tree'
  subject.zoom = 2
  subject.panX = -300
  subject.fitCurrentTree()
  assert.equal(subject.rootId, 'chosen-tree')
  assert.equal(subject._contentIsInsideHost(subject._contentBox()), true)
})

test('group context opens the group without invoking an agent conversation', () => {
  const subject = graph({ agents: [] })
  let opened = null
  subject.setRoot = id => { opened = id }
  subject.onOpenControls = () => { throw new Error('a group is not an agent') }
  subject.treeChat = () => { throw new Error('a group has no session') }
  subject.openChat({ id: '@tree-group:1', agent: { treeScope: { group: true } } })
  assert.equal(opened, '@tree-group:1')
})

test('zoom can follow the far edge of a tree wider than its viewport', () => {
  const subject = fitted({ pane: { w: 1000, h: 800 }, nodes: [
    { id: 'left', x: 200, y: 200, r: 34 },
    { id: 'right', x: 3300, y: 200, r: 34 },
  ] })
  subject.zoom = 0.3
  subject.zoomBy(1.5, 990, 60)
  assert.ok(Math.abs(subject.panX + 3300 * subject.zoom - 990) < 1e-8,
    'pan limits must follow actual tree bounds, or zooming into its far edge slips off the pointer')
})

/* The DOM supplies painted rectangles; the real placer, candidate generator,
   and collision election decide where the preview goes. This is a geometry
   regression, not a claim to have measured fonts or layout in Chromium. */
function placedPreview({ uiZoom, labels, origin = { x: 100, y: 80 }, panX = 0, panY = 0, zoom = 1 }) {
  const border = { x: 2, y: 3 }
  const boxes = labels.map(box => ({
    x: panX + box.x * zoom, y: panY + box.y * zoom,
    w: box.w * zoom, h: box.h * zoom,
  }))
  const paintedRect = box => ({
    left: (origin.x + border.x + box.x) * uiZoom,
    top: (origin.y + border.y + box.y) * uiZoom,
    width: box.w * uiZoom, height: box.h * uiZoom,
  })
  const surface = () => {
    const classes = new Set()
    return {
      classes,
      classList: {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name) },
        add(name) { classes.add(name) },
        remove(name) { classes.delete(name) },
      },
      style: { setProperty() {} },
      setAttribute() {},
      removeAttribute() {},
    }
  }
  const chip = Object.assign(surface(), { offsetHeight: 126 })
  const stack = {
    x: Math.min(...boxes.map(box => box.x)),
    y: Math.min(...boxes.map(box => box.y)),
  }
  stack.w = Math.max(...boxes.map(box => box.x + box.w)) - stack.x
  stack.h = Math.max(...boxes.map(box => box.y + box.h)) - stack.y
  const record = {
    id: 'controller', agent: { role: 'controller' }, x: 400, y: 200, r: 30,
    chip, chipLeader: surface(),
    el: {
      querySelectorAll: () => boxes.map(box => ({ getBoundingClientRect: () => paintedRect(box) })),
      querySelector: () => ({ getBoundingClientRect: () => paintedRect(stack) }),
    },
  }
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    screenChips: true, screenOverlay: {}, editMode: false,
    W: 1000, H: 650, zoom, panX, panY,
    nodes: new Map([[record.id, record]]), emptySlots: new Map(),
    _culled: new Set(), _layoutVisibleIds: new Set([record.id]), _linkSegments: [],
    zoomHost: {
      clientWidth: 1000, clientHeight: 650, clientLeft: border.x, clientTop: border.y,
      ownerDocument: { body: { style: { zoom: String(uiZoom) } } },
      getBoundingClientRect: () => ({ left: origin.x * uiZoom, top: origin.y * uiZoom }),
      querySelector: () => null,
    },
  })
  subject._placeChips()
  return {
    visible: chip.classes.has('screen-chip-visible'),
    box: { x: parseFloat(chip.style.left), y: parseFloat(chip.style.top), w: parseFloat(chip.style.width), h: chip.offsetHeight },
    labels: boxes,
  }
}

const PREVIEW_LABELS = {
  name: [{ x: 330, y: 245, w: 140, h: 20 }, { x: 355, y: 269, w: 90, h: 14 }],
  role: [{ x: 365, y: 235, w: 70, h: 18 }, { x: 320, y: 257, w: 180, h: 14 }],
}
const intersectionArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

for (const uiZoom of TEXT_SIZES) {
  for (const [kind, labels] of Object.entries(PREVIEW_LABELS)) {
    test(`preview leaves its node ${kind} readable at text size ${uiZoom}`, () => {
      const result = placedPreview({ uiZoom, labels })
      assert.equal(result.visible, true, 'a clear nearby preview slot is available')
      for (const label of result.labels) assert.equal(intersectionArea(result.box, label), 0,
        `preview ${JSON.stringify(result.box)} must not paint over label ${JSON.stringify(label)}`)
    })
  }
}

test('preview placement does not drift when text scale or the host position changes', () => {
  for (const movement of [{ panX: 0, panY: 0, zoom: 1 }, { panX: -40, panY: 15, zoom: 1.2 }]) {
    const expected = placedPreview({ uiZoom: 1, labels: PREVIEW_LABELS.name, ...movement })
    assert.equal(expected.visible, true)
    for (const uiZoom of TEXT_SIZES) for (const origin of [{ x: 0, y: 0 }, { x: 100, y: 80 }, { x: 725, y: 340 }]) {
      const actual = placedPreview({ uiZoom, origin, labels: PREVIEW_LABELS.name, ...movement })
      assert.equal(actual.visible, true)
      assert.deepEqual(actual.box, expected.box,
        `identical host-relative geometry must keep the same placement at text size ${uiZoom}, origin ${JSON.stringify(origin)}`)
    }
  }
})

/* Mount the real shelf and composers. DOM stand-in tests cover identity and
   lifecycle; run-tree-chat-workspace.mjs verifies native geometry, resizing,
   keyboard/pointer access and cross-agent sends in Chromium. */
function chatCardFixture(t, uiZoom = 1) {
  const { document, restore } = installDomStandIn()
  document.body.style.zoom = String(uiZoom)
  document.querySelector = selector => document.body.querySelector(selector)
  const host = document.createElement('div')
  host.clientWidth = 1000; host.clientHeight = 650
  document.body.appendChild(host)
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    screenChips: true, W: 1000, H: 650, zoom: 1, panX: 0, panY: 0,
    computer: { agents: [] }, nodes: new Map(), emptySlots: new Map(),
    _culled: new Set(), _layoutVisibleIds: new Set(), zoomHost: host,
    treeChat: agent => ({ title: agent.name, seed: 0, onSend() {} }),
  })
  subject._buildConversationShelf()
  subject.chatShelf.clientWidth = 1000
  t.after(() => {
    for (const record of subject.nodes.values()) subject._disposeChat(record)
    subject.chatShelf.remove()
    restore()
  })
  const addCard = (id = 'controller') => {
    const chip = document.createElement('div')
    document.body.appendChild(chip)
    const record = { id, agent: { id, name: id, role: 'controller', treeNode: true }, chip, chatWidth: 0 }
    subject.nodes.set(id, record)
    subject.computer.agents.push(record.agent)
    subject._layoutVisibleIds.add(id)
    // Use the public opener so a reintroduced close-other-chats loop cannot
    // pass tests that only call the final mounting helper.
    subject.openChat(record)
    return record
  }
  return { subject, record: addCard(), addCard, document }
}

for (const size of TEXT_SIZES) {
  test(`several chats retain their own composer at text size ${size}`, t => {
    const { subject, record, addCard } = chatCardFixture(t, size)
    const input = record.chatRoot.querySelector('.chat-input input')
    input.value = 'Controller draft'
    const second = addCard('manager')
    assert.equal(record.chatOpen, true)
    assert.equal(second.chatOpen, true)
    assert.equal(record.chatPanel.style.width, '100%')
    assert.equal(record.chatPanel.hidden, true)
    assert.equal(second.chatPanel.hidden, false)
    assert.notEqual(second.chatRoot.querySelector('.chat-input input'), input)
    subject._syncConversationShelf()
    assert.equal(input.value, 'Controller draft')
    assert.equal(subject.chatTabs.children.length, 2)
  })

  test(`full chat switching keeps conversations mounted at text size ${size}`, t => {
    const { subject, record, addCard } = chatCardFixture(t, size)
    const second = addCard('manager')
    const firstRoot = record.chatRoot, secondRoot = second.chatRoot
    subject.toggleChatFull(record)
    assert.equal(record.chatPanel.style.width, '100%')
    assert.equal(second.chatPanel.hidden, true)
    subject._focusChat(second)
    assert.equal(second.chatFull, true, 'switching agents preserves full view')
    assert.equal(record.chatPanel.hidden, true)
    subject.toggleChatFull(second)
    assert.equal(second.chatFull, false)
    assert.equal(record.chatPanel.hidden, true, 'only the active tab is visible in the dock too')
    assert.equal(record.chatRoot, firstRoot)
    assert.equal(second.chatRoot, secondRoot)
    subject.chatShelf.querySelector('.tree-chat-collapse').click()
    assert.equal(subject.chatShelf.hidden, true)
    subject._focusChat(record)
    assert.equal(subject.chatShelf.hidden, false)
    assert.equal(record.chatRoot, firstRoot)
  })

  test(`the active conversation fills the available width at text size ${size}`, t => {
    const { subject, record } = chatCardFixture(t, size)
    const original = record.chatRoot
    for (const width of [360, 1000]) {
      subject.chatShelf.clientWidth = width
      subject._syncConversationShelf()
      assert.equal(record.chatPanel.style.width, '100%')
      assert.equal(record.chatRoot, original)
    }
  })
}

test('an explicit spread works even when the details pane leaves less than 900px', () => {
  const subject = fitted({ pane: { w: 800, h: 700 }, nodes: [
    { x: 50, y: 80, r: 39 }, { x: 3150, y: 580, r: 39 },
  ] })
  subject.spacious = true
  subject._spreadRequested = true
  subject.fitToHost({ readable: true })
  assert.equal(subject.zoom, 0.8)
  subject.resetToOverview()
  assert.ok(subject.zoom < 0.3)
  assert.equal(subject._spreadRequested, false)
})

test('fitting a short tree pane leaves the branch hint above its root circle', () => {
  const subject = fitted({ pane: { w: 800, h: 400 }, nodes: [
    { x: 100, y: 100, r: 39 }, { x: 100, y: 700, r: 39 },
  ] })
  subject.zoomHost.querySelector = selector => selector === '.graph-hint.show'
    ? { getBoundingClientRect: () => ({ top: 12, bottom: 46, height: 34 }) } : null
  subject.fitToHost()
  const top = Math.min(...[...subject.nodes.values()].map(record => subject.panY + (record.y - record.r) * subject.zoom))
  assert.ok(top >= 56, 'the root must clear the hint and its padding')
})

test('closing one chat disposes it without closing the others; reopening is immediate', t => {
  const { subject, record, addCard } = chatCardFixture(t)
  const second = addCard('manager')
  const oldPanel = record.chatPanel
  subject.closeChat(record)
  assert.equal(oldPanel.isConnected, false)
  assert.equal(second.chatOpen, true)
  subject.openChat(record)
  assert.equal(record.chatOpen, true)
  assert.notEqual(record.chatPanel, oldPanel)
  assert.equal(subject.chatTrack.children.length, 2)
})

test('Escape acts on the focused conversation and does not close a chat from elsewhere', t => {
  const { subject, record, addCard, document } = chatCardFixture(t)
  const second = addCard('manager')
  subject._escapeTopChat({ key: 'Escape', preventDefault() {}, target: document.body })
  assert.equal(record.chatOpen, true)
  assert.equal(second.chatOpen, true)
  subject.toggleChatFull(record)
  subject._escapeTopChat({ key: 'Escape', preventDefault() {}, target: record.chatPanel })
  assert.equal(record.chatFull, false)
  assert.equal(record.chatOpen, true)
  subject._escapeTopChat({ key: 'Escape', preventDefault() {}, target: record.chatPanel })
  assert.equal(record.chatOpen, true)
  assert.equal(subject.chatShelf.hidden, true)
  assert.equal(second.chatOpen, true)
})

test('destroy releases a background pan capture and clears its gesture state', () => {
  const { document, restore } = installDomStandIn()
  const subject = Object.create(StaticTreeGraph.prototype)
  const host = new PointerTarget('div', document)
  const container = new PointerTarget('div', document)
  const captures = [], releases = []
  host.setPointerCapture = id => captures.push(id)
  host.releasePointerCapture = id => releases.push(id)
  Object.assign(subject, {
    zoomHost: host,
    container,
    nodes: new Map(),
    emptySlots: new Map(),
    unsubs: [],
    _addRafs: new Set(),
    _removeTimers: new Set(),
    _chatTimers: new Set(),
    _animationRaf: 0,
    _dropRec: null,
    _dropRaw: null,
    _nodeDrag: null,
    _panState: null,
    chatOwner: true,
  })
  subject._cancelZoomMotion = () => {}
  subject._stopDragAutoPan = () => {}
  subject.setWide = () => {}
  subject._disposeChat = () => {}
  subject.ro = { disconnect() {} }
  subject.previewFitter = { destroy() {} }
  subject._wireHostInteractions()
  try {
    subject._onPanDown({
      preventDefault() {}, button: 0, pointerId: 41, isPrimary: true,
      clientX: 24, clientY: 40, target: host,
    })
    assert.deepEqual(captures, [41])
    assert.equal(host.classList.contains('panning'), true)
    subject.destroy()
    assert.deepEqual(releases, [41], 'teardown must release an active background-pan capture')
    assert.equal(subject._panState, null, 'teardown must clear the retained pan gesture')
    assert.equal(host.classList.contains('panning'), false, 'teardown must clear the panning affordance')
  } finally {
    restore()
  }
})

/* T1417: after linking two trees the sentence "X › Y linked. ..." sat over the
   top of the canvas, where the tree heads are laid out, until Link mode was
   entered again. It now fades like the canvas status line's confirmations;
   a refusal still stays until the next link action. Drives the real
   _changeLink with an injected link writer. */
test('a linked or unlinked confirmation fades from the canvas while a link refusal stays', async t => {
  const { document, restore } = installDomStandIn()
  t.after(restore)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let answer = { ok: true, links: [] }
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    zoomHost: host, confirmationFadeMs: 20,
    onLinkChange: async () => answer,
    setCommunicationLinks() {}, setLinkMode() {},
    _agentFor: id => ({ name: id === 'head-a' ? 'Controller A' : 'Controller B' }),
  })
  t.after(() => clearTimeout(subject._linkStatusTimer))
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  await subject._changeLink({ from: 'head-a', to: 'head-b', connected: true })
  assert.equal(subject.linkStatus.textContent, 'Controller A › Controller B linked. Messages can flow both ways when their sessions are running.')
  assert.equal(subject.linkStatus.hidden, false)
  await wait(60)
  assert.equal(subject.linkStatus.hidden, true, 'the confirmation must not keep covering the tree heads')
  assert.equal(subject.linkStatus.textContent, '')

  await subject._changeLink({ from: 'head-a', to: 'head-b', connected: false })
  assert.equal(subject.linkStatus.textContent, 'Controller A › Controller B unlinked.')
  await wait(60)
  assert.equal(subject.linkStatus.hidden, true)

  answer = { ok: false, reason: 'The direct link could not be saved.' }
  await subject._changeLink({ from: 'head-a', to: 'head-b', connected: true })
  await wait(60)
  assert.equal(subject.linkStatus.textContent, 'The direct link could not be saved.', 'a refusal waits for the next attempt')
  assert.equal(subject.linkStatus.hidden, false)
})

/* T1464: a move can rename a circle ('Manager (15525313)' becomes
   'Manager 2 (15525313)'). The visible name followed; the accessible name
   and the box's chat button kept the old one, so keyboard and screen-reader
   users heard a name the page no longer showed. */
test('a circle renamed on refresh is announced by its new name, and so is its chat button', () => {
  const subject = graph({ agents: [
    { id: 'root', name: 'Controller', role: 'controller', parentId: null },
    { id: 'moved', name: 'Manager (15525313)', role: 'manager', parentId: 'root' },
  ] })
  subject.nodes = new Map(subject.computer.agents.map(agent => {
    const el = new Element('div')
    el.dataset.parentId = agent.parentId || ''
    el.setAttribute('aria-label', `${agent.name} — Manager; Shift+Enter opens controls`)
    const chat = new Element('button')
    chat.className = 'tree-box-chat'
    chat.setAttribute('aria-label', `Open ${agent.name} in a chat tab`)
    el.appendChild(chat)
    return [agent.id, { id: agent.id, agent, el }]
  }))
  for (const method of ['_renderRuntime', '_renderLaneMarks', '_renderChipPreview', '_refreshChatSession']) subject[method] = () => {}
  subject._syncConversationShelf = () => {}
  subject._layoutNow = () => { subject._layoutResult = {}; subject._layoutKey = subject._structureKey() }
  subject._layoutNow()
  subject.computer.agents = subject.computer.agents.map(agent => agent.id === 'moved' ? { ...agent, name: 'Manager 2 (15525313)' } : agent)
  subject._reconcile()
  const record = subject.nodes.get('moved')
  assert.equal(record.el.getAttribute('aria-label'), 'Manager 2 (15525313) — Manager; Shift+Enter opens controls')
  assert.equal(record.el.querySelector('.tree-box-chat').getAttribute('aria-label'), 'Open Manager 2 (15525313) in a chat tab')
  assert.equal(subject.nodes.get('root').el.getAttribute('aria-label'), 'Controller — Controller; Shift+Enter opens controls')
})

/* T1487: 'Find an agent…' matched only role names, ordinals and ids, so the
   brief a person wrote ('Manager A …') and the tree it belongs to found
   nothing, and every row read like 'Worker (66009264)'. */
test('agent search matches a brief and a tree label, and each row names its tree', t => {
  const { document, restore } = installDomStandIn()
  t.after(restore)
  const shelf = document.createElement('div')
  const list = document.createElement('div')
  list.className = 'tree-chat-options'
  shelf.appendChild(list)
  const agent = (id, name, role, parentId, message) => ({ id, name, role, parentId, treeNode: { id, message } })
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    chatShelf: shelf, chatPicker: { value: '' }, nodes: new Map(),
    computer: { agents: [
      agent('x-root', 'Controller (aaaa1111)', 'controller', null, 'Root xouopb (rig test)'),
      agent('x-mgr', 'Manager (bbbb2222)', 'manager', 'x-root', 'Manager A xouopb\nsecond line'),
      agent('y-root', 'Controller (cccc3333)', 'controller', null, 'Root ynux8y (rig test)'),
      agent('y-worker', 'Worker (dddd4444)', 'worker', 'y-root', 'Collect the logs'),
    ] },
    treeWindows: { getTrees: () => [{ rootId: 'x-root', name: 'Root xouopb (rig test)' }, { rootId: 'y-root', name: 'Root ynux8y (rig test)' }] },
  })
  const rows = query => {
    subject.chatPicker.value = query
    subject._renderChatChoices()
    return list.children.map(row => row.dataset?.agentId ? [row.dataset.agentId, row.querySelector('small').textContent] : [null, row.textContent])
  }
  assert.deepEqual(rows('Manager A'), [['x-mgr', 'Controller (aaaa1111) — Root xouopb (rig test)']], 'a word from the brief finds the agent')
  assert.deepEqual(rows('ynux8y').map(([id]) => id), ['y-root', 'y-worker'], 'a word from the tree label finds every agent in that tree')
  assert.deepEqual(rows('worker'), [['y-worker', 'Controller (cccc3333) — Root ynux8y (rig test)']], 'each row names its tree')
  assert.deepEqual(rows('no such words'), [[null, 'No matching agents.']])
})
